/** Durable, bounded outbox of runner decision reports (owner decision of 11 Nov 2026, "Karar başına sınırlı rapor").
 * One report per final signal decision carries only the eventId, the asset, the action, a closed hold reason and the time.
 * Rationale, plan amounts, assessment evidence, prompts and credentials are never read into it, so they cannot leave the
 * runner. The outbox is written after the decision is already durable and is drained by the daemon with back-off; a report
 * can neither block nor change a decision, and it grants no authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RunnerDecisionReportClient, RUNNER_DECISION_HOLD_REASONS, RUNNER_DECISION_REPORT_CONFLICT, validateRunnerDecisionReport,
  type RunnerDecisionAction, type RunnerDecisionHoldReason, type RunnerDecisionReport } from "@balchemyai/agent-sdk";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { exactKeys, isId, isRecord, isTimestamp } from "./protocol.js";
import { signRunnerDecisionReportProof } from "./pairing-identity.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import type { PrivateSignalJob } from "./private-signal-job.js";
import { addRunnerAgent } from "./agent-roster.js";

/** Pending reports per agent; when full, the oldest pending report is dropped (recorded as done, never resent). */
export const DECISION_OUTBOX_MAX_PENDING = 128;
/** Recently settled eventIds kept for dedupe (oldest forgotten first; a resend is idempotent server-side anyway). */
export const DECISION_OUTBOX_MAX_DONE = 512;
/** Sends per report before it is dropped. */
export const DECISION_OUTBOX_MAX_ATTEMPTS = 10;
/** A report not delivered within this age is dropped. */
export const DECISION_OUTBOX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DECISION_OUTBOX_BACKOFF_BASE_MS = 5_000;
export const DECISION_OUTBOX_BACKOFF_CAP_MS = 300_000;
const MAX_SNAPSHOT_BYTES = 256 * 1024;
const DRAIN_INTERVAL_MS = 2_000;
const SEND_TIMEOUT_MS = 10_000;
/** Answers that will never change for the same report: drop instead of retrying. A 409 is permanent only when the server
 * names a report conflict (a different report is already recorded for this event); a lease conflict, or a 409 without a
 * known reason, backs off and retries within the attempt bound. */
const PERMANENT_STATUSES = new Set([400, 404, 413, 422]);
function permanent(status: number | undefined, code: string | undefined): boolean {
  return status !== undefined && (PERMANENT_STATUSES.has(status) || (status === 409 && code === RUNNER_DECISION_REPORT_CONFLICT));
}
const HOLD_REASONS = new Set<string>(RUNNER_DECISION_HOLD_REASONS);
const BINDING = /^[0-9a-f]{64}$/;

export interface DecisionOutboxEntry {
  serverAgentId: string; bindingDigest: string; report: RunnerDecisionReport;
  attempts: number; enqueuedAt: number; nextAttemptAt: number;
}
interface OutboxRecord { schemaVersion: 1; pending: DecisionOutboxEntry[]; done: string[] }
export type DecisionOutboxOutcome = { kind: "sent" } | { kind: "rejected" } | { kind: "retry"; retryAfterMs?: number };

export class PrivateDecisionOutboxError extends Error {
  constructor() { super("Decision report outbox unavailable"); this.name = "PrivateDecisionOutboxError"; }
}
function fail(): never { throw new PrivateDecisionOutboxError(); }

/** Bounded projection of one final signal decision. Exactly six fields are copied; nothing else of the job is read. */
export function privateDecisionReport(job: PrivateSignalJob): Readonly<RunnerDecisionReport> | undefined {
  try {
    if (job.kind !== "signal_decision") return undefined;
    let action: RunnerDecisionAction; let holdReason: RunnerDecisionHoldReason | null;
    if (job.state === "completed" && job.result) { action = job.result.decision.action; holdReason = null; }
    else if (job.state === "held" && job.reason) { action = "hold"; holdReason = HOLD_REASONS.has(job.reason) ? job.reason as RunnerDecisionHoldReason : "other"; }
    else if (job.state === "failed" && job.error) { action = "hold"; holdReason = HOLD_REASONS.has(job.error) ? job.error as RunnerDecisionHoldReason : "other"; }
    else return undefined;
    return validateRunnerDecisionReport({ version: 1, eventId: job.receipt.signal.eventId, assetId: job.receipt.signal.assetId, action, holdReason,
      decidedAt: new Date(job.updatedAt).toISOString() });
  } catch { return undefined; }
}
export function decisionOutboxFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `decision-outbox-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
/** Exponential back-off with jitter in [half, full] of the step, or the server's Retry-After (both capped). */
export function decisionOutboxDelay(attempts: number, random: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return Math.max(DECISION_OUTBOX_BACKOFF_BASE_MS, Math.min(retryAfterMs, DECISION_OUTBOX_BACKOFF_CAP_MS));
  }
  const step = Math.min(DECISION_OUTBOX_BACKOFF_CAP_MS, DECISION_OUTBOX_BACKOFF_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 16));
  const jitter = Math.min(Math.max(Number.isFinite(random) ? random : 0, 0), 1);
  return Math.max(DECISION_OUTBOX_BACKOFF_BASE_MS, Math.floor(step / 2 + jitter * (step / 2)));
}
function decodeEntry(value: unknown): DecisionOutboxEntry {
  if (!isRecord(value) || !exactKeys(value, ["serverAgentId", "bindingDigest", "report", "attempts", "enqueuedAt", "nextAttemptAt"])) fail();
  if (typeof value.serverAgentId !== "string" || value.serverAgentId.length > 64 || !isId(value.serverAgentId)
    || typeof value.bindingDigest !== "string" || !BINDING.test(value.bindingDigest)
    || !isTimestamp(value.attempts) || value.attempts > DECISION_OUTBOX_MAX_ATTEMPTS
    || !isTimestamp(value.enqueuedAt) || !isTimestamp(value.nextAttemptAt)) fail();
  let report: RunnerDecisionReport;
  try { report = { ...validateRunnerDecisionReport(value.report) }; } catch { return fail(); }
  return { serverAgentId: value.serverAgentId, bindingDigest: value.bindingDigest, report, attempts: value.attempts,
    enqueuedAt: value.enqueuedAt, nextAttemptAt: value.nextAttemptAt };
}
/** The newest DECISION_OUTBOX_MAX_DONE settled eventIds. Every write that grows `done` goes through this, so a valid outbox
 * never exceeds the bound decodeRecord enforces (that bound stays strict for real corruption). */
function recentDone(done: readonly string[]): string[] { return done.slice(Math.max(0, done.length - DECISION_OUTBOX_MAX_DONE)); }
function decodeRecord(value: unknown): OutboxRecord {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "pending", "done"]) || value.schemaVersion !== 1
    || !Array.isArray(value.pending) || value.pending.length > DECISION_OUTBOX_MAX_PENDING
    || !Array.isArray(value.done) || value.done.length > DECISION_OUTBOX_MAX_DONE) fail();
  const pending = value.pending.map(decodeEntry);
  const done = value.done.map((eventId: unknown) => { if (typeof eventId !== "string" || !/^lsi_[0-9a-f]{64}$/.test(eventId)) fail(); return eventId; });
  const ids = new Set([...pending.map((entry) => entry.report.eventId), ...done]);
  if (ids.size !== pending.length + done.length) fail();
  return { schemaVersion: 1, pending, done };
}

export interface PrivateDecisionOutboxOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this store never creates a second lock. */
  assertAvailable(): void;
  /** Wall clock in ms (persisted retry times survive a restart). Injectable for tests. */
  now?(): number;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<OutboxRecord> };

/** One private 0600 snapshot per agent, created on the first report. A damaged file holds that agent's outbox (no reports
 * are sent or written for it) and never affects decisions. */
export class PrivateDecisionOutbox {
  readonly #options: PrivateDecisionOutboxOptions;
  readonly #agentIds: string[];
  readonly #directory: string;
  readonly #slots = new Map<string, Slot>();
  #closed = false;

  constructor(options: PrivateDecisionOutboxOptions) {
    if (!isRecord(options) || !isId(options.localProfileId) || !Array.isArray(options.agentIds) || options.agentIds.length > 64
      || options.agentIds.some((id) => !isId(id)) || new Set(options.agentIds).size !== options.agentIds.length
      || typeof options.assertAvailable !== "function" || typeof options.directory !== "string" || !path.isAbsolute(options.directory)
      || (options.now !== undefined && typeof options.now !== "function")) fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds };
    this.#directory = path.resolve(options.directory);
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Records the bounded report of one final decision. Never throws; false when nothing was written (not final, a duplicate
   * eventId, an unknown agent or an unavailable outbox). */
  enqueue(job: PrivateSignalJob): boolean {
    try {
      if (this.#closed || !this.#options.agentIds.includes(job.agentId)) return false;
      const report = privateDecisionReport(job);
      if (!report || !isId(job.receipt.serverAgentId) || !BINDING.test(job.receipt.bindingDigest)) return false;
      this.#options.assertAvailable();
      const current = this.#read(job.agentId) ?? { schemaVersion: 1, pending: [], done: [] };
      if (current.done.includes(report.eventId) || current.pending.some((entry) => entry.report.eventId === report.eventId)) return false;
      const now = this.#now();
      const next: OutboxRecord = { schemaVersion: 1, pending: [...current.pending], done: [...current.done] };
      while (next.pending.length >= DECISION_OUTBOX_MAX_PENDING) next.done.push(next.pending.shift()!.report.eventId);
      next.pending.push({ serverAgentId: job.receipt.serverAgentId, bindingDigest: job.receipt.bindingDigest, report: { ...report },
        attempts: 0, enqueuedAt: now, nextAttemptAt: now });
      // An overflow grows `done`; trim before the write so the snapshot always decodes within its bound.
      this.#write(job.agentId, { ...next, done: recentDone(next.done) });
      return true;
    } catch { return false; }
  }

  /** The earliest due report of this agent, after dropping reports past their age bound. */
  next(agentId: string): DecisionOutboxEntry | undefined {
    const current = this.#available(agentId) ? this.#read(agentId) : undefined;
    if (!current) return undefined;
    const now = this.#now();
    const expired = current.pending.filter((entry) => now - entry.enqueuedAt > DECISION_OUTBOX_MAX_AGE_MS);
    if (expired.length) {
      this.#write(agentId, this.#settled(current, expired.map((entry) => entry.report.eventId)));
      return this.next(agentId);
    }
    const due = current.pending.filter((entry) => entry.nextAttemptAt <= now).sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);
    return due[0] ? structuredClone(due[0]) : undefined;
  }

  /** sent and rejected settle the report for good; retry backs off, and drops it after the attempt bound. */
  settle(agentId: string, eventId: string, outcome: DecisionOutboxOutcome, random = Math.random()): void {
    const current = this.#available(agentId) ? this.#read(agentId) : undefined;
    const entry = current?.pending.find((item) => item.report.eventId === eventId);
    if (!current || !entry) return;
    if (outcome.kind !== "retry" || entry.attempts + 1 >= DECISION_OUTBOX_MAX_ATTEMPTS) {
      this.#write(agentId, this.#settled(current, [eventId])); return;
    }
    const attempts = entry.attempts + 1;
    const nextAttemptAt = this.#now() + decisionOutboxDelay(attempts, random, outcome.retryAfterMs);
    this.#write(agentId, { ...current, pending: current.pending.map((item) => item.report.eventId === eventId ? { ...item, attempts, nextAttemptAt } : item) });
  }

  pending(agentId: string): number { return (this.#available(agentId) ? this.#read(agentId) : undefined)?.pending.length ?? 0; }

  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Closed regardless. */ } }
    this.#slots.clear();
  }

  #now(): number { const now = (this.#options.now ?? Date.now)(); if (!isTimestamp(now)) fail(); return now; }
  #available(agentId: string): boolean {
    if (this.#closed || !this.#options.agentIds.includes(agentId)) return false;
    try { this.#options.assertAvailable(); return true; } catch { return false; }
  }
  #settled(current: OutboxRecord, eventIds: string[]): OutboxRecord {
    const done = [...current.done, ...eventIds.filter((id) => !current.done.includes(id))];
    return { schemaVersion: 1, pending: current.pending.filter((entry) => !eventIds.includes(entry.report.eventId)), done: recentDone(done) };
  }
  #read(agentId: string): OutboxRecord | undefined {
    let slot = this.#slots.get(agentId);
    if (!slot) {
      const files = decisionOutboxFiles(agentId);
      const exists = (name: string): boolean => {
        try { fs.lstatSync(path.join(this.#directory, name)); return true; }
        catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
      };
      let present: boolean;
      try { present = exists(files.markerFile) || exists(files.snapshotFile); } catch { return fail(); }
      if (!present) return undefined;
      slot = this.#open(agentId);
    }
    if (slot.kind === "held") fail();
    try { return slot.storage.read(); } catch { this.#hold(agentId); return fail(); }
  }
  #write(agentId: string, next: OutboxRecord): void {
    const slot = this.#slots.get(agentId);
    try {
      if (slot?.kind === "open") slot.storage.commit(next);
      else if (!slot) { const opened = this.#open(agentId, next); if (opened.kind !== "open") fail(); opened.storage.commit(next); }
      else fail();
    } catch { this.#hold(agentId); fail(); }
  }
  /** With `initial`, an absent outbox is created (marker + fsync, then snapshot + fsync + rename). */
  #open(agentId: string, initial?: OutboxRecord): Slot {
    let storage: OwnedJsonSnapshot<OutboxRecord> | undefined;
    try {
      storage = new OwnedJsonSnapshot<OutboxRecord>({ directory: this.#directory, ...decisionOutboxFiles(agentId),
        marker: { schemaVersion: 1, localProfileId: this.#options.localProfileId, agentId, kind: "decision_outbox" },
        maximumBytes: MAX_SNAPSHOT_BYTES, initial: initial ?? { schemaVersion: 1, pending: [], done: [] },
        assertAvailable: this.#options.assertAvailable, decode: decodeRecord });
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch {
      try { storage?.close(); } catch { /* Preserve files; no detail leaves this boundary. */ }
      return this.#hold(agentId);
    }
  }
  #hold(agentId: string): Slot {
    const current = this.#slots.get(agentId);
    if (current?.kind === "open") { try { current.storage.close(); } catch { /* Held regardless. */ } }
    const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held;
  }
}

export interface RunnerDecisionReportBridgeOptions {
  directory: string; localProfileId: string; instanceId: string; agentIds: readonly string[];
  outbox: PrivateDecisionOutbox;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  /** Test seam; production signs with the runner key and uses the SDK's public report route. */
  send?(agentId: string, lease: Readonly<RunnerRuntimeActiveLease>, report: RunnerDecisionReport, signal: AbortSignal): Promise<void>;
  fetchFn?: typeof fetch;
  random?(): number;
}
/** HTTP status and machine code of a failed send, when the server answered; transport failures have none. */
function failure(error: unknown): { status?: number; code?: string; retryAfterMs?: number } {
  if (!isRecord(error)) return {};
  const status = typeof error.status === "number" ? error.status : undefined;
  const code = typeof error.machineCode === "string" ? error.machineCode : undefined;
  const seconds = error.retryAfterSeconds;
  return { ...(status !== undefined ? { status } : {}), ...(code !== undefined ? { code } : {}),
    ...(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 && (status === 429 || status === 503) ? { retryAfterMs: seconds * 1_000 } : {}) };
}

/** Drains each agent's outbox while this instance holds the agent's live lease: one report at a time, signed per send. */
export class RunnerDecisionReportBridge {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;
  private abort?: AbortController;
  private closed = false;

  readonly #agentIds: string[];
  private readonly options: RunnerDecisionReportBridgeOptions;
  constructor(options: RunnerDecisionReportBridgeOptions) { this.#agentIds = [...options.agentIds]; this.options = { ...options, agentIds: this.#agentIds }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => { void this.drain(); }, DRAIN_INTERVAL_MS);
    this.timer.unref();
  }
  /** One pass over every agent; overlapping calls join the running pass. */
  drain(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.running ??= this.pass().finally(() => { this.running = undefined; });
    return this.running;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.abort?.abort();
    await this.running?.catch(() => undefined);
  }
  private lease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined {
    const lease = this.closed ? undefined : this.options.readLease(agentId);
    if (!lease || lease.instanceId !== this.options.instanceId || !Number.isSafeInteger(lease.epoch) || lease.epoch < 1
      || !Number.isFinite(lease.remainingMs) || lease.remainingMs <= 0) return undefined;
    return lease;
  }
  private async pass(): Promise<void> {
    for (const agentId of this.options.agentIds) {
      if (this.closed) return;
      try {
        const lease = this.lease(agentId); if (!lease) continue;
        const entry = this.options.outbox.next(agentId); if (!entry) continue;
        // A report belongs to the binding its signal arrived under; after a re-pair the server cannot accept it.
        if (entry.serverAgentId !== lease.agentId || entry.bindingDigest !== lease.bindingDigest) {
          this.options.outbox.settle(agentId, entry.report.eventId, { kind: "rejected" }); continue;
        }
        const abort = new AbortController(); this.abort = abort;
        const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS); timer.unref();
        let outcome: DecisionOutboxOutcome;
        try {
          if (this.options.send) await this.options.send(agentId, lease, entry.report, abort.signal);
          else await this.send(agentId, lease, entry.report, abort.signal);
          outcome = { kind: "sent" };
        } catch (error: unknown) {
          const { status, code, retryAfterMs } = failure(error);
          outcome = permanent(status, code) ? { kind: "rejected" }
            : { kind: "retry", ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
        } finally { clearTimeout(timer); if (this.abort === abort) this.abort = undefined; }
        if (this.closed && outcome.kind === "retry") return; // A shutdown abort is not a failed attempt.
        this.options.outbox.settle(agentId, entry.report.eventId, outcome, (this.options.random ?? Math.random)());
      } catch { /* An unavailable outbox or lease read skips this agent until the next pass. */ }
    }
  }
  private async send(agentId: string, lease: Readonly<RunnerRuntimeActiveLease>, report: RunnerDecisionReport, signal: AbortSignal): Promise<void> {
    const client = new RunnerDecisionReportClient({ frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
      runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, apiBaseUrl: `${lease.frontendOrigin}/api`, timeoutMs: SEND_TIMEOUT_MS,
      ...(this.options.fetchFn ? { fetchFn: this.options.fetchFn } : {}),
      signer: (nonce, expected) => {
        const current = this.lease(agentId);
        if (!current || current.agentId !== lease.agentId || current.bindingDigest !== lease.bindingDigest || current.epoch !== expected.epoch) {
          throw new PrivateDecisionOutboxError();
        }
        return signRunnerDecisionReportProof({ directory: this.options.directory, localProfileId: this.options.localProfileId, agentId },
          { instanceId: lease.instanceId, epoch: expected.epoch, report: expected.report, nonce });
      } });
    await client.submit(report, lease.epoch, signal);
  }
}
