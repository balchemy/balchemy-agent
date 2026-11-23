import { performance } from "node:perf_hooks";
import {
  RunnerControlClient, runnerControlLocalReceiptId,
  type RunnerControlAckBody, type RunnerControlCommand, type RunnerControlObservation,
  type RunnerControlState,
} from "@balchemyai/agent-sdk";
import { signRunnerControlProof } from "./pairing-identity.js";
import { parseAgentState, type RunnerRequest, type RunnerResponse } from "./protocol.js";
import { addRunnerAgentEntry } from "./agent-roster.js";
import type { RunnerReceiptLookup } from "./state.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

const INTERVAL_MS = 5_000;
const MAX_PENDING = 12;

interface Pending {
  command: RunnerControlCommand;
  observation: RunnerControlObservation;
}
interface Entry {
  client?: RunnerControlClient;
  target?: string;
  pending: Map<string, Pending>;
  nextPoll: number;
  nextAck: number;
  busy: boolean;
  abort: AbortController;
  fetchCleanups: Set<() => void>;
}
export interface RunnerControlBridgeOptions {
  directory: string;
  localProfileId: string;
  instanceId: string;
  agentIds: string[];
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  lookupReceipt(request: RunnerRequest): RunnerReceiptLookup;
  control(request: RunnerRequest): RunnerResponse;
  fetchFn?: typeof fetch;
  monotonicNow?: () => number;
}

function targetKey(lease: RunnerRuntimeActiveLease): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId]);
}
function localRequest(agentId: string, command: RunnerControlCommand): RunnerRequest {
  return { version: 1, id: runnerControlLocalReceiptId(command.commandDigest), agentId,
    action: command.action === "resume_shadow" ? "resume" : command.action, expectedVersion: command.expectedVersion };
}
function unknown(reason: Extract<RunnerControlObservation, { outcome: "unknown" }>["reason"]): RunnerControlObservation {
  return Object.freeze({ outcome: "unknown", reason });
}
function publicState(value: unknown, agentId: string): RunnerControlState {
  const state = parseAgentState(value);
  if (state.agentId !== agentId) throw new Error("Control state target mismatch");
  return Object.freeze({ mode: state.mode, lifecycle: state.lifecycle, version: state.version,
    armed: state.armed, execution: "unavailable", brain: "not_attached", ...(state.entries ? { entries: state.entries } : {}) });
}
function receiptObservation(lookup: RunnerReceiptLookup, agentId: string, command: RunnerControlCommand): RunnerControlObservation {
  if (lookup.kind !== "found") return unknown(lookup.kind === "conflict" ? "receipt_conflict"
    : lookup.kind === "unavailable" ? "state_unavailable" : "receipt_missing");
  const response = lookup.response;
  if (response.id !== runnerControlLocalReceiptId(command.commandDigest) || response.hub) return unknown("receipt_conflict");
  try {
    const state = publicState(response.state, agentId);
    if (!response.ok) {
      return response.error === "version_conflict" && state.version !== command.expectedVersion
        ? Object.freeze({ outcome: "rejected", code: "version_conflict", state }) : unknown("receipt_conflict");
    }
    const before = command.beforeState;
    const exact = !(state.version !== command.expectedVersion + 1
      // Pause of an armed agent keeps it live_armed with new entries paused; any other pause lands on paused.
      || (command.action === "pause" && (before.mode === "live_armed"
        ? state.mode !== "live_armed" || state.entries !== "paused" || state.lifecycle !== before.lifecycle
        : state.mode !== "paused" || state.lifecycle !== before.lifecycle))
      || (command.action === "disarm" && (state.mode !== (before.mode === "live_armed" ? "live_unarmed" : before.mode) || state.lifecycle !== before.lifecycle))
      || (command.action === "resume_shadow" && (state.mode !== "shadow" || state.lifecycle !== "idle"))
      || (command.action === "stop" && (state.mode !== "paused" || state.lifecycle !== "stopped")));
    if (exact) return Object.freeze({ outcome: "applied", state });
    // Ensure-disarm / ensure-stop of a state that moved on since the web read it: the safe state was ensured locally, but
    // the command's own precondition did not hold, so it is acknowledged as a version conflict carrying the current state.
    // Known limitation (S8b review P3-4): Hub then shows "rejected" although the agent is unarmed/stopped. The observation
    // codec is closed on both sides (SDK control-client `observation`, backend local-agent-control.dto): `applied` must be
    // exactly expectedVersion + 1 and there is no third outcome, so an "ensured" observation cannot be added here without a
    // coordinated SDK + backend change (a new outcome or code accepted as applied-equivalent). The carried state is truthful.
    // Phase 1 audit M3: an ensure-pause of an armed agent whose version moved (a change or exits-only hold in between) is acknowledged
    // the same way: new entries are paused (it stays live_armed), carried truthfully as a version conflict. The wire is unchanged.
    const safe = command.action === "disarm" ? state.mode !== "live_armed" && !state.armed
      : command.action === "pause" ? state.mode === "live_armed" && state.armed && state.entries === "paused"
      : command.action === "stop" && state.mode === "paused" && state.lifecycle === "stopped";
    return safe && state.version > command.expectedVersion ? Object.freeze({ outcome: "rejected", code: "version_conflict", state }) : unknown("receipt_conflict");
  } catch { return unknown("receipt_conflict"); }
}

/** Web intents enter the same durable store as CLI controls. Heartbeats remain
 * independent. Historical recovery only reads receipts; it never reapplies. */
export class RunnerControlBridge {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: RunnerControlBridgeOptions) {
    this.now = options.monotonicNow ?? (() => performance.now());
    for (const agentId of options.agentIds) this.entries.set(agentId, this.newEntry());
  }
  private newEntry(): Entry {
    return { pending: new Map(), nextPoll: 0, nextAck: 0, busy: false, abort: new AbortController(), fetchCleanups: new Set() };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon gets the same fresh entry the constructor
   * gives every agent (polled from the next pass); every other agent's entry, lease and in-flight exchange are untouched. Idempotent;
   * nothing is added after close; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { if (!this.closed) addRunnerAgentEntry(this.entries, agentId, () => this.newEntry()); }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, 1_000);
    this.timer.unref();
    void this.poll();
  }

  async poll(): Promise<void> {
    if (this.closed) return;
    const attempts: Promise<void>[] = [];
    for (const [agentId, entry] of this.entries) {
      if (entry.busy || this.now() < entry.nextPoll) continue;
      entry.busy = true;
      entry.nextPoll = this.now() + INTERVAL_MS;
      const attempt = this.exchange(agentId, entry).finally(() => {
        entry.busy = false; this.inFlight.delete(attempt);
      });
      this.inFlight.add(attempt); attempts.push(attempt);
    }
    await Promise.all(attempts);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.entries.values()) entry.abort.abort();
    await Promise.allSettled([...this.inFlight]);
  }

  private fetchFor(entry: Entry): typeof fetch {
    return async (input, init) => {
      const controller = new AbortController();
      const sources = [entry.abort.signal, init?.signal].filter((value): value is AbortSignal => Boolean(value));
      const abort = (): void => controller.abort();
      for (const signal of sources) {
        if (signal.aborted) controller.abort();
        else signal.addEventListener("abort", abort, { once: true });
      }
      entry.fetchCleanups.add(() => { for (const signal of sources) signal.removeEventListener("abort", abort); });
      return (this.options.fetchFn ?? globalThis.fetch)(input, { ...init, signal: controller.signal });
    };
  }

  private lease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined {
    if (this.closed) return undefined;
    const lease = this.options.readLease(agentId);
    if (!lease || lease.instanceId !== this.options.instanceId || !Number.isSafeInteger(lease.epoch)
      || lease.epoch < 1 || !Number.isFinite(lease.remainingMs) || lease.remainingMs <= 0) return undefined;
    return lease;
  }

  private observe(agentId: string, command: RunnerControlCommand, deadline?: number): RunnerControlObservation {
    const request = localRequest(agentId, command);
    let lookup = this.options.lookupReceipt(request);
    if (lookup.kind !== "missing" || deadline === undefined) return receiptObservation(lookup, agentId, command);
    const lease = this.lease(agentId);
    if (!lease || command.agentId !== lease.agentId || command.bindingDigest !== lease.bindingDigest
      || command.targetInstanceId !== lease.instanceId || command.targetEpoch !== lease.epoch || this.now() >= deadline) {
      return unknown("receipt_missing");
    }
    // No await between the final lease/deadline check and the canonical store.
    // A response is not durable proof; confirm through the exact receipt lookup.
    const response = this.options.control(request);
    lookup = this.options.lookupReceipt(request);
    if (lookup.kind === "missing" && response.error === "journal_full") return unknown("journal_full");
    return receiptObservation(lookup, agentId, command);
  }

  private async exchange(agentId: string, entry: Entry): Promise<void> {
    try {
      const lease = this.lease(agentId);
      if (!lease) return;
      const target = targetKey(lease);
      if (entry.target && entry.target !== target) return; // Never silently retarget an adopted agent.
      if (!entry.client) {
        entry.target = target;
        entry.client = new RunnerControlClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId,
          bindingDigest: lease.bindingDigest, runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId,
          apiBaseUrl: `${lease.frontendOrigin}/api`, timeoutMs: 5_000, fetchFn: this.fetchFor(entry),
          signer: (nonce, expected) => signRunnerControlProof({ directory: this.options.directory,
            localProfileId: this.options.localProfileId, agentId }, { instanceId: this.options.instanceId, nonce,
            operation: expected.action === "poll" ? { action: "poll", body: expected.body }
              : { action: "ack", command: expected.command, body: expected.body } }),
        });
      }
      let priority: string | undefined;
      try {
        const sentAt = this.now();
        // Start at the oldest unresolved receipt. Each accepted ACK removes it
        // from this epoch's recovery scan; skipped page entries remain eligible.
        const result = await entry.client.poll({ epoch: lease.epoch, recoveryCursor: null });
        const elapsed = this.now() - sentAt;
        if (this.closed || !Number.isFinite(elapsed) || elapsed < 0) return;
        if (result.delivery) {
          const command = result.delivery.command;
          priority = command.commandDigest;
          if (!entry.pending.has(priority)) {
            // Reserve a slot for new delivery without dropping an already
            // attempted ACK. Recovery admission always leaves this one free.
            if (entry.pending.size < MAX_PENDING) {
              const deadline = this.now() + Math.max(0, Math.min(lease.remainingMs - elapsed,
                Date.parse(command.expiresAt) - Date.parse(result.serverTime) - elapsed));
              entry.pending.set(priority, { command, observation: this.observe(agentId, command, deadline) });
            }
          }
        }
        for (const recovery of result.recoveries) {
          const command = recovery.command;
          if (entry.pending.has(command.commandDigest)) continue;
          if (entry.pending.size >= MAX_PENDING - 1) break;
          entry.pending.set(command.commandDigest, { command, observation: this.observe(agentId, command) });
        }
      } catch {
        // Poll failure cannot erase an already durable local receipt or change
        // the frozen observation retained after a lost ACK response.
      }
      const current = this.lease(agentId);
      if (!current || targetKey(current) !== target || this.now() < entry.nextAck) return;
      const pending = (priority ? entry.pending.get(priority) : undefined) ?? entry.pending.values().next().value as Pending | undefined;
      if (!pending) return;
      const body: RunnerControlAckBody = Object.freeze({ epoch: current.epoch, commandId: pending.command.commandId,
        commandDigest: pending.command.commandDigest, localReceiptId: runnerControlLocalReceiptId(pending.command.commandDigest),
        observation: pending.observation });
      entry.nextAck = this.now() + INTERVAL_MS;
      // A new proving epoch may reconcile an old receipt. The command and
      // observation never change. The SDK also accepts an UNKNOWN ACK resolving
      // to the server's existing, validated terminal receipt for this command.
      await entry.client.ack(pending.command, body);
      entry.pending.delete(pending.command.commandDigest);
    } catch {
      // No provider payloads, identity material or private configuration in logs.
    } finally {
      for (const cleanup of entry.fetchCleanups) cleanup();
      entry.fetchCleanups.clear();
    }
  }
}
