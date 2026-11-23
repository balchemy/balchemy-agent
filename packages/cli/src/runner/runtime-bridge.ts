import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
  RunnerRuntimeClient, type RunnerRuntimeActionBody, type RunnerRuntimeLeaseReceipt,
  type RunnerRuntimeState, type RunnerBrainObservation, type RunnerKeystoreObservation, validateRunnerBrainObservation,
  validateRunnerKeystoreObservation,
} from "@balchemyai/agent-sdk";
import {
  readPairedRunnerDescriptor, signRunnerRuntimeProof, type PairedRunnerDescriptor,
} from "./pairing-identity.js";
import { parseAgentState, type RunnerAgentState, type RunnerHubStatus } from "./protocol.js";
import { addRunnerAgentEntry } from "./agent-roster.js";

const POLL_MS = 1_000;
const HEARTBEAT_MS = 10_000;
const RETRY_MS = 5_000;
// A lost response retains its exact body. After the maximum lease window plus
// transport/commit allowance, a new acquisition intent can only succeed through
// the server's expired-lease CAS. This never authorizes execution locally.
const UNKNOWN_WINDOW_MS = 45_000;

export type RunnerRuntimeBridgeStatus = RunnerHubStatus;

/** Read-only fence for control delivery, never an execution authorization. */
export interface RunnerRuntimeActiveLease extends PairedRunnerDescriptor {
  instanceId: string;
  epoch: number;
  remainingMs: number;
}

interface Pending {
  operation: RunnerRuntimeActionBody;
  startedAt: number;
}
interface Entry {
  descriptor?: PairedRunnerDescriptor;
  client?: RunnerRuntimeClient;
  pending?: Pending;
  receipt?: RunnerRuntimeLeaseReceipt;
  /** The state body of the latest acquire/heartbeat Balchemy accepted (its runtime mirror), cleared with the receipt. */
  accepted?: RunnerRuntimeState;
  leaseDeadline: number;
  nextAttempt: number;
  busy: boolean;
  /** A nudge that arrived while a report was in flight: the finished report must not swallow it. */
  dirty: boolean;
  status: RunnerRuntimeBridgeStatus;
  abort: AbortController;
  fetchCleanups: Set<() => void>;
}

export interface RunnerRuntimeBridgeOptions {
  directory: string;
  localProfileId: string;
  instanceId: string;
  agentIds: string[];
  /** Reads the same durable store used by local CLI control; never mutates it. */
  readState(agentId: string): RunnerAgentState | undefined;
  readBrainObservation?(agentId: string): RunnerBrainObservation;
  /** Trading-keystore lock state only (closed enum): never an address, key or passphrase. */
  readKeystore?(agentId: string): RunnerKeystoreObservation;
  fetchFn?: typeof fetch;
  /** Monotonic elapsed time, not the wall clock used in signed server nonces. */
  monotonicNow?: () => number;
  /** Called after Balchemy accepted a report for this agent (the execution worker re-checks a wait for the server's mirror). */
  onAccepted?(agentId: string): void;
}

/** Final audit N5: the SDK's closed marker of a proven clock difference with Balchemy (code invalid_response, details.reason
 * "clock_skew"). Only this boolean is kept; the error itself (its text, any provider body) is dropped. An SDK without the marker
 * simply never sets it. */
function clockSkew(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, details } = error as { code?: unknown; details?: unknown };
  return code === "invalid_response" && !!details && typeof details === "object" && (details as { reason?: unknown }).reason === "clock_skew";
}

function sameDescriptor(left: PairedRunnerDescriptor, right: PairedRunnerDescriptor): boolean {
  return left.frontendOrigin === right.frontendOrigin && left.agentId === right.agentId
    && left.bindingDigest === right.bindingDigest && left.runnerPublicKey === right.runnerPublicKey;
}

/** Sends only allowlisted operational enums. No rule content, model context or keys. The signed heartbeat mirrors the
 * durable local mode (including live_armed / armed:true after the owner's CLI arming); the server only records it. */
export class RunnerRuntimeBridge {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: RunnerRuntimeBridgeOptions) {
    this.now = options.monotonicNow ?? (() => performance.now());
    for (const agentId of options.agentIds) this.entries.set(agentId, this.newEntry());
  }
  private newEntry(): Entry {
    return { leaseDeadline: 0, nextAttempt: 0, busy: false, dirty: false,
      status: { connection: "not_paired" }, abort: new AbortController(), fetchCleanups: new Set() };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon gets the same fresh entry the constructor
   * gives every agent (polled from the next pass); every other agent's entry, lease and in-flight exchange are untouched. Idempotent;
   * nothing is added after close; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { if (!this.closed) addRunnerAgentEntry(this.entries, agentId, () => this.newEntry()); }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, POLL_MS);
    this.timer.unref();
    void this.poll();
  }

  /** One bounded attempt per due agent; overlapping polls never duplicate it. */
  async poll(): Promise<void> {
    if (this.closed) return;
    const attempts: Promise<void>[] = [];
    for (const [agentId, entry] of this.entries) {
      if (entry.busy || this.now() < entry.nextAttempt) continue;
      entry.busy = true;
      const attempt = this.report(agentId, entry).finally(() => {
        entry.busy = false;
        this.inFlight.delete(attempt);
        // A local control change during this report: report the new state now, not at the report's next interval.
        if (entry.dirty && !this.closed) { entry.dirty = false; entry.nextAttempt = 0; void this.poll(); }
      });
      this.inFlight.add(attempt);
      attempts.push(attempt);
    }
    await Promise.all(attempts);
  }

  /** Report this agent's current state at the next poll (after a local control change), not at the next interval. */
  nudge(agentId: string): void {
    const entry = this.entries.get(agentId); if (!entry) return;
    if (entry.busy) entry.dirty = true; else entry.nextAttempt = 0;
  }

  status(agentId: string): RunnerRuntimeBridgeStatus | undefined {
    const entry = this.entries.get(agentId);
    if (!entry) return undefined;
    const value = { ...entry.status };
    if (value.connection === "reporting" && (this.closed || this.now() >= entry.leaseDeadline)) {
      value.connection = "unavailable";
    }
    return value;
  }

  /** M3.6 F-M36-1: the local runtime version Balchemy has accepted as live_armed + armed (the state its build and submit arming
   * gate reads) under a still-active lease, else null. Read-only; it never arms or authorizes anything by itself. */
  acceptedArmedVersion(agentId: string): number | null {
    const accepted = this.entries.get(agentId)?.accepted;
    if (!accepted || !this.activeLease(agentId)) return null;
    return accepted.mode === "live_armed" && accepted.armed === true ? accepted.version : null;
  }

  activeLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined {
    const entry = this.entries.get(agentId);
    if (this.closed || !entry?.descriptor || !entry.receipt
      || !["reporting", "connecting"].includes(entry.status.connection)) return undefined;
    const remainingMs = entry.leaseDeadline - this.now();
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return undefined;
    return Object.freeze({ ...entry.descriptor, instanceId: this.options.instanceId,
      epoch: entry.receipt.epoch, remainingMs });
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
      // Keep cancellation connected through response-body parsing, not merely
      // until fetch resolves its headers. report() releases both request hooks.
      entry.fetchCleanups.add(() => { for (const signal of sources) signal.removeEventListener("abort", abort); });
      return (this.options.fetchFn ?? globalThis.fetch)(input, { ...init, signal: controller.signal });
    };
  }

  private async report(agentId: string, entry: Entry): Promise<void> {
    const identityOptions = { directory: this.options.directory, localProfileId: this.options.localProfileId, agentId };
    try {
      const descriptor = readPairedRunnerDescriptor(identityOptions);
      if (!descriptor) {
        entry.status = { connection: entry.descriptor ? "unavailable" : "not_paired" };
        entry.nextAttempt = this.now() + RETRY_MS;
        return;
      }
      if (entry.descriptor && !sameDescriptor(entry.descriptor, descriptor)) throw new Error("Runtime identity changed");
      if (!entry.client) {
        entry.descriptor = descriptor;
        entry.client = new RunnerRuntimeClient({ ...descriptor, instanceId: this.options.instanceId,
          apiBaseUrl: `${descriptor.frontendOrigin}/api`, timeoutMs: 5_000, fetchFn: this.fetchFor(entry),
          signer: (nonce, expected) => signRunnerRuntimeProof(identityOptions, {
            instanceId: this.options.instanceId, nonce,
            operation: expected.action === "acquire" ? { action: "acquire", body: expected.body }
              : { action: "heartbeat", body: expected.body },
          }),
        });
      }
      const local = parseAgentState(this.options.readState(agentId));
      if (local.agentId !== agentId || this.closed) return;
      const now = this.now();
      // A saved armed body is never re-sent once the local state moved on (disarm, stop, pause, re-arm): the server's
      // live_armed mirror must not be refreshed from a stale body. The lease is given up; re-acquisition reports the
      // current state only (until then the backend sees no fresh armed heartbeat and refuses every build and submit).
      if (entry.pending && ((now - entry.pending.startedAt >= UNKNOWN_WINDOW_MS)
        || (entry.pending.operation.body.state.armed && entry.pending.operation.body.state.version !== local.version))) {
        entry.pending = undefined; entry.receipt = undefined; entry.accepted = undefined; entry.leaseDeadline = 0;
      }
      if (!entry.pending) {
        const state: RunnerRuntimeState = Object.freeze({ mode: local.mode, lifecycle: local.lifecycle,
          version: local.version, armed: local.armed, execution: "unavailable", brain: "not_attached",
          ...(local.entries ? { entries: local.entries } : {}) });
        const observed = {
          ...(this.options.readBrainObservation ? { brainObservation: validateRunnerBrainObservation(this.options.readBrainObservation(agentId)) } : {}),
          ...(this.options.readKeystore ? { keystore: validateRunnerKeystoreObservation(this.options.readKeystore(agentId)) } : {}),
        };
        const operation: RunnerRuntimeActionBody = entry.receipt && now < entry.leaseDeadline
          ? { action: "heartbeat", body: Object.freeze({ epoch: entry.receipt.epoch, sequence: entry.receipt.sequence + 1, state, ...observed }) }
          : { action: "acquire", body: Object.freeze({ requestId: randomUUID(), state, ...observed }) };
        entry.pending = { operation: Object.freeze(operation), startedAt: now };
      }
      entry.status = { connection: "connecting", serverAgentId: descriptor.agentId,
        ...(entry.receipt ? { lastConfirmedAt: entry.receipt.acceptedAt } : {}) };
      const operation = entry.pending.operation;
      const sentAt = this.now();
      const receipt = operation.action === "acquire" ? await entry.client.acquire(operation.body)
        : await entry.client.heartbeat(operation.body);
      if (this.closed) return;
      // Subtract the complete request duration. A delayed/recovered receipt
      // never grants a fresh local 30-second window from its arrival time.
      const elapsed = this.now() - sentAt;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error("Invalid monotonic clock");
      const remaining = Date.parse(receipt.leaseExpiresAt) - Date.parse(receipt.serverTime) - elapsed;
      entry.pending = undefined;
      entry.receipt = receipt;
      entry.accepted = operation.body.state;
      entry.leaseDeadline = this.now() + Math.max(0, remaining);
      // A recovered older body (pending from before a local change, e.g. the owner's arm) was just accepted: report the
      // current state at the next poll, not at the heartbeat interval.
      entry.nextAttempt = operation.body.state.version !== local.version ? 0
        : this.now() + Math.min(HEARTBEAT_MS, Math.max(RETRY_MS, remaining / 2));
      entry.status = { connection: remaining > 0 ? "reporting" : "unavailable",
        serverAgentId: descriptor.agentId, lastConfirmedAt: receipt.acceptedAt };
      try { this.options.onAccepted?.(agentId); } catch { /* A listener never affects reporting. */ }
    } catch (error: unknown) {
      // Preserve the frozen pending body for fresh-nonce reconciliation. Never
      // log provider bodies, keys, proofs or private local configuration. Only the closed clock marker is kept (status text only;
      // the connection, the lease and the retry are exactly as for any other failure).
      entry.status = { connection: "unavailable", ...(clockSkew(error) ? { reason: "clock_skew" as const } : {}),
        ...(entry.descriptor ? { serverAgentId: entry.descriptor.agentId } : {}),
        ...(entry.receipt ? { lastConfirmedAt: entry.receipt.acceptedAt } : {}) };
      entry.nextAttempt = this.now() + RETRY_MS;
    } finally {
      for (const cleanup of entry.fetchCleanups) cleanup();
      entry.fetchCleanups.clear();
    }
  }
}
