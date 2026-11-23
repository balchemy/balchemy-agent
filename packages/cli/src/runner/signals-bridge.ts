import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { RunnerSignalsClient, type RunnerSignalsRequest } from "@balchemyai/agent-sdk";
import { signRunnerSignalsProof } from "./pairing-identity.js";
import { addRunnerAgentEntry } from "./agent-roster.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import type { PrivateSignalReceiptInput } from "./private-signal-job.js";

const POLL_MS = 5_000;
const PROOF_INTERVAL_MS = 1_000;
const MAX_ACTIVE = 2;
/** Back-off after HTTP 429/503: exponential from POLL_MS with jitter, capped; a server Retry-After is honoured up to its own bound. */
const BACKOFF_CAP_MS = 60_000;
const RETRY_AFTER_CAP_MS = 300_000;
/** Accepted ACKs remembered per agent for the execution worker (bounded, oldest first out). */
const MAX_ACKNOWLEDGED = 256;
/** A durably received event whose ACK outcome is unknown is re-ACKed for at most the signal decision's own age bound. */
const UNCONFIRMED_ACK_MS = 300_000;
const MAX_UNCONFIRMED = 16;
interface Entry {
  target?: string;
  nextPoll: number;
  nextProof: number;
  abort?: AbortController;
  /** Consecutive 429/503 answers; zero outside a back-off episode. */
  failures: number;
  /** eventId -> eventDigest of every ACK Balchemy answered (its inbox row has receivedAt). */
  acknowledged: Map<string, string>;
  /** Durably received events whose ACK was sent but not answered. The server ACK is idempotent (an already received event
   * returns its original receivedAt) and a received event is not polled again, so only a re-sent ACK can confirm it. */
  unconfirmed: Map<string, { eventDigest: string; since: number }>;
}
export interface RunnerSignalsBridgeOptions {
  directory: string;
  localProfileId: string;
  instanceId: string;
  agentIds: string[];
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  /** Resolve only after durable receipt commit, never after merely enqueueing. */
  receive(agentId: string, receipt: PrivateSignalReceiptInput, signal: AbortSignal): Promise<void>;
  fetchFn?: typeof fetch;
  monotonicNow?: () => number;
  /** Jitter source in [0, 1). Injectable for tests. */
  random?: () => number;
  /** Receives one fixed-format line per back-off episode; never any identity, proof or payload data. */
  log?: (line: string) => void;
  /** Called after Balchemy answered an ACK (the execution worker re-checks a build waiting for it). */
  onAcknowledged?(agentId: string): void;
}
/** Only an overloaded or throttled server asks for back-off; every other failure keeps the plain cadence. */
function throttleSignal(error: unknown): { status: number; retryAfterMs?: number } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const { status, retryAfterSeconds } = error as { status?: unknown; retryAfterSeconds?: unknown };
  if (status !== 429 && status !== 503) return undefined;
  return typeof retryAfterSeconds === "number" && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? { status, retryAfterMs: Math.min(retryAfterSeconds * 1_000, RETRY_AFTER_CAP_MS) } : { status };
}
function target(lease: RunnerRuntimeActiveLease): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest, lease.runnerPublicKey, lease.instanceId]);
}

/** Public signal transport only. A receipt ACK grants no model or execution authority. */
export class RunnerSignalsBridge {
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Set<Promise<void>>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: RunnerSignalsBridgeOptions) {
    this.now = options.monotonicNow ?? (() => performance.now());
    for (const agentId of options.agentIds) this.entries.set(agentId, this.newEntry());
  }
  private newEntry(): Entry { return { nextPoll: 0, nextProof: 0, failures: 0, acknowledged: new Map(), unconfirmed: new Map() }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon gets the same fresh entry the constructor
   * gives every agent (polled from the next pass); every other agent's entry, lease and in-flight exchange are untouched. Idempotent;
   * nothing is added after close; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { if (!this.closed) addRunnerAgentEntry(this.entries, agentId, () => this.newEntry()); }
  /** M3.6 F-M36-2: true once Balchemy answered this exact event's ACK in this process. Execution provenance requires the
   * ACK's receivedAt, so no build may be requested for a signal before this is true. Grants no authority by itself. */
  acknowledged(agentId: string, eventId: string, eventDigest: string): boolean {
    return this.entries.get(agentId)?.acknowledged.get(eventId) === eventDigest;
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, 1_000);
    this.timer.unref();
    void this.poll();
  }
  async poll(): Promise<void> {
    if (this.closed) return;
    const attempts: Promise<void>[] = [];
    for (const [agentId, entry] of [...this.entries]) {
      if (this.inFlight.size >= MAX_ACTIVE) break;
      const now = this.now();
      if (entry.abort || !Number.isFinite(now) || now < entry.nextPoll) continue;
      entry.abort = new AbortController();
      entry.nextPoll = now + POLL_MS;
      // Rotate scheduled agents so a slow or continuously due pair cannot starve others.
      this.entries.delete(agentId); this.entries.set(agentId, entry);
      const attempt = this.exchange(agentId, entry, entry.abort).finally(() => {
        entry.abort = undefined; this.inFlight.delete(attempt);
      });
      this.inFlight.add(attempt); attempts.push(attempt);
    }
    await Promise.all(attempts);
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.entries.values()) entry.abort?.abort();
    await Promise.allSettled([...this.inFlight]);
  }
  private backOff(entry: Entry, error: unknown): void {
    const signal = throttleSignal(error);
    if (!signal || this.closed) return;
    const base = Math.min(BACKOFF_CAP_MS, POLL_MS * 2 ** Math.min(++entry.failures, 16));
    const jitter = Math.min(Math.max((this.options.random ?? Math.random)(), 0), 1);
    const delay = signal.retryAfterMs !== undefined ? Math.max(POLL_MS, signal.retryAfterMs)
      : Math.max(POLL_MS, Math.floor(base / 2 + jitter * (base / 2)));
    const now = this.now();
    if (Number.isFinite(now)) entry.nextPoll = Math.max(entry.nextPoll, now + delay);
    if (entry.failures === 1) {
      try { this.options.log?.(`Signals poll answered HTTP ${signal.status}; backing off ${Math.round(delay / 1_000)}s`); } catch { /* A logger never gates polling. */ }
    }
  }
  private lease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined {
    if (this.closed) return undefined;
    const lease = this.options.readLease(agentId);
    if (!lease || lease.instanceId !== this.options.instanceId || !Number.isSafeInteger(lease.epoch)
      || lease.epoch < 1 || !Number.isFinite(lease.remainingMs) || lease.remainingMs <= 0) return undefined;
    return lease;
  }
  private async exchange(agentId: string, entry: Entry, abort: AbortController): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const initial = this.lease(agentId);
      if (!initial) return;
      const pinned = target(initial), epoch = initial.epoch, started = this.now();
      if (!Number.isFinite(started) || (entry.target !== undefined && entry.target !== pinned)) return;
      entry.target = pinned;
      // Even a renewed heartbeat cannot extend this cycle past its original monotonic bound.
      const duration = Math.min(30_000, Math.floor(initial.remainingMs));
      if (duration < 1) return;
      const deadline = started + duration;
      timer = setTimeout(() => abort.abort(), duration); timer.unref();
      const fence = (): void => {
        const current = this.lease(agentId), now = this.now();
        if (abort.signal.aborted || !current || target(current) !== pinned || current.epoch !== epoch
          || !Number.isFinite(now) || now < started || now >= deadline) throw new Error("Signal lease unavailable");
      };
      const client = new RunnerSignalsClient({ frontendOrigin: initial.frontendOrigin, agentId: initial.agentId,
        bindingDigest: initial.bindingDigest, runnerPublicKey: initial.runnerPublicKey, instanceId: initial.instanceId,
        apiBaseUrl: `${initial.frontendOrigin}/api`, timeoutMs: Math.min(5_000, duration),
        fetchFn: async (input, init) => { fence(); return (this.options.fetchFn ?? globalThis.fetch)(input, init); },
        signer: (nonce, expected) => {
          fence();
          return signRunnerSignalsProof({ directory: this.options.directory, localProfileId: this.options.localProfileId, agentId },
            { instanceId: initial.instanceId, epoch: expected.epoch, request: expected.request, nonce });
        },
      });
      const query = async (request: RunnerSignalsRequest) => {
        fence();
        while (this.now() < entry.nextProof) {
          await delay(Math.ceil(entry.nextProof - this.now()), undefined, { signal: abort.signal }); fence();
        }
        try { return await client.query(request, epoch, abort.signal); }
        finally { entry.nextProof = this.now() + PROOF_INTERVAL_MS; }
      };
      const ack = async (eventId: string, eventDigest: string, since = this.now()): Promise<void> => {
        entry.unconfirmed.delete(eventId);
        if (entry.unconfirmed.size >= MAX_UNCONFIRMED) entry.unconfirmed.delete(entry.unconfirmed.keys().next().value as string);
        entry.unconfirmed.set(eventId, { eventDigest, since });
        const answer = await query({ kind: "ack", eventId, eventDigest });
        if (answer.result.kind !== "ack") return;
        entry.unconfirmed.delete(eventId);
        entry.acknowledged.delete(eventId); entry.acknowledged.set(eventId, eventDigest);
        if (entry.acknowledged.size > MAX_ACKNOWLEDGED) entry.acknowledged.delete(entry.acknowledged.keys().next().value as string);
        try { this.options.onAcknowledged?.(agentId); } catch { /* A listener never affects the transport. */ }
      };
      const response = await query({ kind: "poll" }); fence();
      entry.failures = 0; // The episode ends with the first answered poll.
      if (response.result.kind !== "poll") return;
      for (const signal of response.result.signals) {
        fence();
        const receipt: PrivateSignalReceiptInput = Object.freeze({ localProfileId: this.options.localProfileId, agentId,
          frontendOrigin: initial.frontendOrigin, serverAgentId: initial.agentId, bindingDigest: initial.bindingDigest,
          instanceId: initial.instanceId, epoch, receivedAt: new Date().toISOString(), signal });
        await this.options.receive(agentId, receipt, abort.signal);
        fence(); // A durable commit alone never authorizes a stale instance to ACK.
        await ack(signal.eventId, signal.eventDigest);
        fence();
      }
      // A row of a platform this runner does not know (a newer server): ACKed without any decision, so it never blocks the inbox.
      for (const ignored of response.result.ignored ?? []) {
        fence();
        await ack(ignored.eventId, ignored.eventDigest);
        fence();
      }
      // ACKs sent in an earlier cycle without an answer: the event was durably received, so re-sending the same ACK is safe.
      for (const [eventId, pending] of [...entry.unconfirmed]) {
        fence();
        if (this.now() - pending.since >= UNCONFIRMED_ACK_MS) { entry.unconfirmed.delete(eventId); continue; }
        await ack(eventId, pending.eventDigest, pending.since);
        fence();
      }
    } catch (error: unknown) {
      // Unknown ACKs are resolved by a later poll and the local durable dedupe key (ACK not applied), or by the re-sent
      // ACK above (applied, answer lost).
      // Never log proofs, private context, provider payloads or identity material.
      this.backOff(entry, error);
    } finally {
      if (timer) clearTimeout(timer);
      abort.abort();
    }
  }
}
