/** Daemon-owned private conversation journal. No credentials or execution authority. */
import * as path from "node:path";
import * as fs from "node:fs";
import { WorkingArchive, BRAIN_ARCHIVE_PREFIX, workingArchiveHead, type WorkingArchiveHead } from "./private-working-archive.js";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot, OwnedJsonSnapshotError } from "./owned-json-snapshot.js";
import { exactKeys, isId, isRecord } from "./protocol.js";
import { MAX_PRIVATE_BRAIN_TEXT_BYTES, isPrivateBrainText, parsePrivateBrainJob, parsePrivateBrainRequest,
  type PrivateBrainChatCreateRequest, type PrivateBrainErrorCode, type PrivateBrainJob,
  type PrivateBrainJobFailure } from "./private-brain-protocol.js";
import { MAX_PRIVATE_SIGNAL_JOB_BYTES, parsePrivateSignalJob, validatePrivateSignalReceipt, privateSignalJobId,
  privateSignalReceiptDigest, parsePrivateSignalAdmission, type PrivateSignalReceiptInput, type PrivateSignalJob, type PrivateSignalStart,
  type PrivateSignalResult, type PrivateSignalHoldReason, type PrivateSignalFailure } from "./private-signal-job.js";
import { PRIVATE_SIGNAL_PAGE_SIZE, summarizePrivateSignalJob, type PrivateSignalPage } from "./private-signal-protocol.js";

import { PrivateAutonomyError, PrivateAutonomyCounter, AUTONOMOUS_TOKEN_COOLDOWN_MS,
  initialPrivateAutonomyCheckpoint, parsePrivateAutonomyCheckpoint, parsePrivateAutonomyPolicyInput,
  parsePrivateSignalCallReservation, privateSignalAdmissionDigest, privateSignalCallId, privateAutonomyUtcDay,
  nextPrivateAutonomyUtcDay, unpreparedPrivateAutonomyStatus, type PrivateAutonomyCheckpoint,
  type PrivateAutonomyStatus, type PrivateAutonomyCheck, type PrivateAutonomyPolicyInput,
  type PrivateAutonomyReservationInput, type PrivateSignalCallReservation } from "./private-autonomy.js";

import { PrivateSizingError, parsePrivateBuyAmountPolicyInput, buildPrivateBuyAmountPolicy, privateSizingSlippageUsable,
  parsePrivateSizingCheckpoint, type PrivateBuyAmountPolicy, type PrivateBuyAmountPolicyInput,
  type PrivateSizingCheckpoint } from "./private-sizing.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_BRAIN_SNAPSHOT_FILE = "private-brain-jobs.json";
export const PRIVATE_BRAIN_INITIALIZED_FILE = "private-brain-jobs.initialized";
export const MAX_PRIVATE_BRAIN_JOBS = 128;
const MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
const MAX_HISTORY_BYTES = 64 * 1024;
interface StoredChatJob { job: PrivateBrainJob; text: string; digest: string; ordinal?: number }
interface StoredSignalJob { kind: "signal_decision"; job: PrivateSignalJob; digest: string; ordinal?: number }
type StoredJob = StoredChatJob | StoredSignalJob;
type Snapshot = { schemaVersion: 1; localProfileId: string; jobs: StoredJob[] }
  | { schemaVersion: 2 | 3; localProfileId: string; jobs: StoredJob[]; archiveHead: WorkingArchiveHead | null; nextOrdinal: number }
  | { schemaVersion: 4; localProfileId: string; jobs: StoredJob[]; archiveHead: WorkingArchiveHead | null; nextOrdinal: number; autonomy: PrivateAutonomyCheckpoint[] }
  | { schemaVersion: 5; localProfileId: string; jobs: StoredJob[]; archiveHead: WorkingArchiveHead | null; nextOrdinal: number; autonomy: PrivateAutonomyCheckpoint[]; sizing: PrivateSizingCheckpoint[] };
export interface PrivateBrainStoreOperation { signal?: AbortSignal; guard?: () => void }
const ASYNC_OPEN = Symbol("private-brain async open");
function isSignal(entry: StoredJob): entry is StoredSignalJob { return "kind" in entry; }
function active(entry: StoredJob): boolean { return entry.job.state === "queued" || entry.job.state === "received" || entry.job.state === "running"; }
function head(snapshot: Snapshot): WorkingArchiveHead | null { return snapshot.schemaVersion !== 1 ? snapshot.archiveHead : null; }
function ordinal(entry: StoredJob, index: number): number { return entry.ordinal ?? index + 1; }
export interface PrivateBrainWork { job: PrivateBrainJob; text: string }
export interface PrivateBrainHistoryEntry { jobId: string; text: string; reply: string; modelRevision: number; completedAt: number }
export interface PrivateBrainStoreOptions {
  directory: string;
  localProfileId: string;
  instanceId: string;
  agentIds: string[];
  /** Must throw unless the daemon still holds its existing exclusive writer.
   * This store never acquires or releases that writer; the caller owns it. */
  assertAvailable(): void;
}
export class PrivateBrainStoreError extends Error {
  constructor(readonly code: PrivateBrainErrorCode) { super(`Private brain ${code}`); this.name = "PrivateBrainStoreError"; }
}
function fail(code: PrivateBrainErrorCode): never { throw new PrivateBrainStoreError(code); }
function copy<T>(value: T): T { return structuredClone(value); }
function digest(localProfileId: string, job: PrivateBrainJob, text: string): string {
  return createHash("sha256").update(JSON.stringify(["balchemy.private-chat.v1", localProfileId,
    job.agentId, job.jobId, job.originalInstanceId, job.modelRevision, text]), "utf8").digest("hex");
}

export class PrivateBrainStore {
  readonly directory: string;
  private readonly options: PrivateBrainStoreOptions;
  private readonly agentList: string[];
  private readonly storage: OwnedJsonSnapshot<Snapshot>;
  private snapshot: Snapshot;
  private readonly archive: WorkingArchive<StoredJob>;
  private held = false;
  private readonly yieldQueue: Array<() => void> = [];
  private yieldScheduled = false;
  private readonly autonomyCounters = new Map<string, PrivateAutonomyCounter>();

  constructor(options: PrivateBrainStoreOptions, asynchronous?: typeof ASYNC_OPEN) {
    if (!isId(options.localProfileId) || !isId(options.instanceId) || !Array.isArray(options.agentIds)
      || options.agentIds.length === 0 || options.agentIds.length > 64 || options.agentIds.some((id) => !isId(id))
      || new Set(options.agentIds).size !== options.agentIds.length || typeof options.assertAvailable !== "function"
      || typeof options.directory !== "string" || !path.isAbsolute(options.directory)) fail("invalid_request");
    this.agentList = [...options.agentIds]; this.options = { ...options, agentIds: this.agentList };
    this.directory = path.resolve(options.directory);
    this.snapshot = { schemaVersion: 1, localProfileId: options.localProfileId, jobs: [] };
    this.archive = new WorkingArchive({ namespace: "brain", directory: this.directory, localProfileId: options.localProfileId,
      maximumBytes: MAX_SNAPSHOT_BYTES + 1024, maximumRecords: MAX_PRIVATE_BRAIN_JOBS,
      assertAvailable: () => this.assertAvailable(), decodeRecords: (value) => this.decodeJobs(value, true, true, true) });
    let storage: OwnedJsonSnapshot<Snapshot> | undefined;
    try {
      options.assertAvailable();
      if (!fs.existsSync(path.join(this.directory, PRIVATE_BRAIN_SNAPSHOT_FILE))
        && !fs.existsSync(path.join(this.directory, PRIVATE_BRAIN_INITIALIZED_FILE))
        && fs.readdirSync(this.directory).some((name) => name.startsWith(BRAIN_ARCHIVE_PREFIX))) fail("state_unavailable");
      storage = new OwnedJsonSnapshot({ directory: this.directory,
        snapshotFile: PRIVATE_BRAIN_SNAPSHOT_FILE, markerFile: PRIVATE_BRAIN_INITIALIZED_FILE,
        marker: { schemaVersion: 1, localProfileId: options.localProfileId },
        maximumBytes: MAX_SNAPSHOT_BYTES, initial: this.snapshot,
        decode: (value) => this.decode(value), assertAvailable: () => options.assertAvailable() });
      this.storage = storage;
      this.snapshot = storage.read();
      if (asynchronous !== ASYNC_OPEN) {
        if (head(this.snapshot)) fail("state_unavailable");
        const now = Date.now(); this.initializeAutonomyCounters(now);
        this.snapshot.jobs.forEach((entry) => this.collectAutonomyReservation(entry, now));
        this.verifyAutonomyCounters();
        this.recoverInterrupted();
      }
    } catch {
      storage?.close();
      fail("state_unavailable");
    }
  }

  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.agentList, agentId); }
  /** Exact replay is read-only, including after restart or model lock. The caller
   * still checks the current transport instance before dispatching a new intent. */
  create(input: PrivateBrainChatCreateRequest, modelRevision: number): PrivateBrainJob {
    const request = this.request(input);
    const previous = this.snapshot.jobs.find((entry) => entry.job.jobId === request.jobId);
    if (previous) return this.replay(previous, request);
    if (head(this.snapshot)) fail("state_unavailable");
    const entry = this.newEntry(request, modelRevision);
    if (this.snapshot.jobs.length >= MAX_PRIVATE_BRAIN_JOBS) fail("journal_full");
    const next = copy(this.snapshot); this.push(next, entry); this.reserveCompletion(next); this.commit(next);
    return copy(entry.job);
  }

  static async open(options: PrivateBrainStoreOptions, operation: PrivateBrainStoreOperation = {}): Promise<PrivateBrainStore> {
    options = { ...options, agentIds: [...options.agentIds] }; operation = { ...operation };
    if (operation.signal?.aborted) fail("cancelled"); operation.guard?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (operation.signal?.aborted) fail("cancelled"); operation.guard?.();
    const store = new PrivateBrainStore(options, ASYNC_OPEN);
    try {
      const prior = store.snapshot;
      const now = Date.now(); store.initializeAutonomyCounters(now);
      await store.scan((entry) => store.collectAutonomyReservation(entry, now), prior, operation);
      store.verifyAutonomyCounters();
      await store.pause(prior, operation);
      store.recoverInterrupted();
      return store;
    } catch (error: unknown) { store.close(); throw error; }
  }

  async createAsync(input: PrivateBrainChatCreateRequest, modelRevision: number, operation: PrivateBrainStoreOperation = {}): Promise<PrivateBrainJob> {
    const request = this.request(input); operation = { ...operation }; const prior = this.snapshot;
    this.fence(prior, operation);
    const currentReplay = this.snapshot.jobs.find((entry) => entry.job.jobId === request.jobId);
    // The current checkpoint is authoritative for its bounded window. Historical
    // integrity is validated at open and historical lookup, never claimed here.
    if (currentReplay) return this.replay(currentReplay, request);
    let previous: StoredJob | undefined;
    await this.scan((entry) => {
      if (entry.job.jobId === request.jobId) {
        if (previous) { this.held = true; fail("state_unavailable"); }
        previous = entry;
      }
    }, prior, operation);
    this.fence(prior, operation);
    previous = this.snapshot.jobs.find((item) => item.job.jobId === request.jobId) ?? previous;
    if (previous) return this.replay(previous, request);
    await this.pause(prior, operation);
    const current = this.snapshot;
    previous = current.jobs.find((item) => item.job.jobId === request.jobId);
    if (previous) return this.replay(previous, request);
    const entry = this.newEntry(request, modelRevision);
    this.append(entry, current, prior, operation);
    return copy(entry.job);
  }

  private append(entry: StoredJob, current: Snapshot, prior: Snapshot, operation: PrivateBrainStoreOperation): void {
    let next = copy(current);
    if (isSignal(entry) && next.schemaVersion !== 3 && next.schemaVersion !== 4 && next.schemaVersion !== 5) {
      next = { schemaVersion: 3, localProfileId: this.options.localProfileId, archiveHead: head(current),
        nextOrdinal: current.schemaVersion !== 1 ? current.nextOrdinal : current.jobs.length + 1,
        jobs: current.jobs.map((item, index) => ({ ...copy(item), ordinal: ordinal(item, index) })) };
    }
    if (next.jobs.length >= MAX_PRIVATE_BRAIN_JOBS) {
      const terminal = next.jobs.flatMap((item, index) => active(item) ? [] : [{ ...item, ordinal: ordinal(item, index) }]);
      if (!terminal.length) fail("journal_full");
      let archiveHead: WorkingArchiveHead;
      try { archiveHead = this.archive.preserve(terminal, head(current)); }
      catch { this.held = true; fail("state_unavailable"); }
      this.fence(prior, operation);
      next = { ...next, schemaVersion: next.schemaVersion === 1 ? 2 : next.schemaVersion,
        localProfileId: this.options.localProfileId, archiveHead,
        nextOrdinal: current.schemaVersion !== 1 ? current.nextOrdinal : current.jobs.length + 1,
        jobs: current.jobs.flatMap((item, index) => active(item) ? [{ ...item, ordinal: ordinal(item, index) }] : []) } as Snapshot;
    }
    this.push(next, entry); this.reserveCompletion(next);
    this.fence(prior, operation);
    if (this.snapshot !== current) fail("revision_conflict");
    this.commit(next);
  }

  /** One atomic durable receipt and decision identity. The caller may ACK only
   * after success, and enqueue only when created is true. No model is required. */
  async recordSignalAsync(input: PrivateSignalReceiptInput, operation: PrivateBrainStoreOperation = {}): Promise<{ created: boolean; job: PrivateSignalJob }> {
    let receipt: PrivateSignalReceiptInput;
    try { receipt = validatePrivateSignalReceipt(input); } catch { fail("invalid_request"); }
    this.assertAvailable();
    if (receipt.localProfileId !== this.options.localProfileId) fail("profile_conflict");
    this.agent(receipt.agentId);
    const jobId = privateSignalJobId(receipt); operation = { ...operation }; const prior = this.snapshot;
    this.fence(prior, operation);
    const currentReplay = this.snapshot.jobs.find((entry) => entry.job.jobId === jobId);
    if (currentReplay) return { created: false, job: this.replaySignal(currentReplay, receipt) };
    let previous: StoredJob | undefined;
    await this.scan((entry) => {
      if (entry.job.jobId === jobId) {
        if (previous) { this.held = true; fail("state_unavailable"); }
        previous = entry;
      }
    }, prior, operation);
    this.fence(prior, operation);
    previous = this.snapshot.jobs.find((entry) => entry.job.jobId === jobId) ?? previous;
    if (previous) return { created: false, job: this.replaySignal(previous, receipt) };
    await this.pause(prior, operation);
    const current = this.snapshot;
    previous = current.jobs.find((entry) => entry.job.jobId === jobId);
    if (previous) return { created: false, job: this.replaySignal(previous, receipt) };
    if (receipt.instanceId !== this.options.instanceId) fail("instance_conflict");
    const now = Date.now();
    let job: PrivateSignalJob;
    try { job = parsePrivateSignalJob({ kind: "signal_decision", jobId, agentId: receipt.agentId,
      originalInstanceId: receipt.instanceId, generation: 1, state: "received", createdAt: now, updatedAt: now, receipt }); }
    catch { fail("invalid_request"); }
    this.append({ kind: "signal_decision", job, digest: privateSignalReceiptDigest(receipt) }, current, prior, operation);
    return { created: true, job: copy(job) };
  }

  private replaySignal(entry: StoredJob, receipt: PrivateSignalReceiptInput): PrivateSignalJob {
    if (!isSignal(entry)) fail("job_conflict");
    const original = entry.job.receipt;
    if (original.localProfileId !== receipt.localProfileId || original.agentId !== receipt.agentId
      || original.frontendOrigin !== receipt.frontendOrigin || original.serverAgentId !== receipt.serverAgentId
      || original.bindingDigest !== receipt.bindingDigest || JSON.stringify(original.signal) !== JSON.stringify(receipt.signal)) fail("job_conflict");
    return copy(entry.job);
  }

  readSignal(agentId: string, jobId: string): PrivateSignalJob { return copy(this.findSignal(agentId, jobId).job); }

  /** Read-only even for a pre-enforcement journal. Cache reconstruction happens
   * alongside the existing validated async open, never by activating policy. */
  autonomyStatus(agentId: string, nowMs: number): PrivateAutonomyStatus {
    this.assertAvailable(); this.agent(agentId); privateAutonomyUtcDay(nowMs);
    const checkpoint = this.autonomyCheckpoint(agentId);
    if (!checkpoint) return unpreparedPrivateAutonomyStatus(agentId, nowMs);
    const counter = this.autonomyCounters.get(agentId);
    if (!checkpoint.activation || !counter) return { ...unpreparedPrivateAutonomyStatus(agentId, nowMs), policy: copy(checkpoint.policy),
      legacyHoldUntilMs: checkpoint.activation?.legacyHoldUntilMs ?? null };
    return copy(counter.status(checkpoint, nowMs));
  }

  /** Owner policy CAS. Exact latest-operation recovery is read-only; an older
   * expected revision cannot silently overwrite a later owner choice. */
  setAutonomyPolicy(agentId: string, input: PrivateAutonomyPolicyInput, nowMs: number,
    operation: PrivateBrainStoreOperation = {}): PrivateAutonomyStatus {
    this.agent(agentId); const request = parsePrivateAutonomyPolicyInput(input); privateAutonomyUtcDay(nowMs);
    const prior = this.snapshot; this.fence(prior, operation);
    const checkpoint = this.autonomyCheckpoint(agentId) ?? initialPrivateAutonomyCheckpoint(agentId, nowMs);
    const previous = (this.snapshot.schemaVersion === 4 || this.snapshot.schemaVersion === 5)
      ? this.snapshot.autonomy.find((item) => item.lastPolicyChange?.operationId === request.operationId) : undefined;
    if (previous) {
      if (previous.agentId !== agentId || JSON.stringify(previous.lastPolicyChange) !== JSON.stringify(request)) throw new PrivateAutonomyError("operation_conflict");
      return this.autonomyStatus(agentId, nowMs);
    }
    if (checkpoint.policy.revision !== request.expectedRevision || !Number.isSafeInteger(request.expectedRevision + 1))
      throw new PrivateAutonomyError("revision_conflict");
    if (nowMs < checkpoint.clockHighWaterMs || this.autonomyStatus(agentId, nowMs).reason === "clock_rollback")
      throw new PrivateAutonomyError("clock_rollback");
    const next = this.withAutonomy(this.snapshot);
    this.putAutonomyCheckpoint(next, { ...copy(checkpoint), clockHighWaterMs: nowMs,
      policy: { revision: request.expectedRevision + 1, dailyCallLimit: request.dailyCallLimit, tokenCooldownMs: AUTONOMOUS_TOKEN_COOLDOWN_MS },
      lastPolicyChange: request });
    this.reserveCompletion(next); this.fence(prior, operation); this.commit(next);
    return this.autonomyStatus(agentId, nowMs);
  }

  /** Owner-selected setup amount is independent from call budgets and risk caps.
   * Reading it never creates policy, guesses an amount or modifies a journal. */
  sizingPolicy(agentId: string): PrivateBuyAmountPolicy | null {
    this.assertAvailable(); this.agent(agentId);
    return copy(this.snapshot.schemaVersion === 5
      ? this.snapshot.sizing.find((item) => item.agentId === agentId)?.policy ?? null : null);
  }

  /** Recover only the latest exact operation, without applying today's rule head.
   * An older operation cannot overwrite a subsequent owner choice. */
  sizingPolicyChange(agentId: string, input: PrivateBuyAmountPolicyInput): PrivateBuyAmountPolicy | null {
    this.assertAvailable(); this.agent(agentId); const request = parsePrivateBuyAmountPolicyInput(input);
    const previous = this.snapshot.schemaVersion === 5
      ? this.snapshot.sizing.find((item) => item.lastChange.operationId === request.operationId) : undefined;
    if (!previous) return null;
    if (previous.agentId !== agentId || JSON.stringify(previous.lastChange) !== JSON.stringify(request))
      throw new PrivateSizingError("operation_conflict");
    return copy(previous.policy);
  }

  setSizingPolicy(agentId: string, input: PrivateBuyAmountPolicyInput, nowMs: number,
    operation: PrivateBrainStoreOperation = {}): PrivateBuyAmountPolicy {
    this.agent(agentId); const request = parsePrivateBuyAmountPolicyInput(input);
    const prior = this.snapshot; this.fence(prior, operation);
    const previous = this.sizingPolicyChange(agentId, request);
    if (previous) return previous;
    const existing = this.sizingPolicy(agentId);
    if ((existing?.revision ?? 0) !== request.expectedRevision) throw new PrivateSizingError("revision_conflict");
    if (existing && nowMs < existing.updatedAt) throw new PrivateSizingError("clock_rollback");
    // A new owner change above the execution slippage bound could never buy: refused (an exact replay above returned first).
    if (!privateSizingSlippageUsable(request.slippageBps)) throw new PrivateSizingError("invalid_request");
    const policy = buildPrivateBuyAmountPolicy({ localProfileId: this.options.localProfileId, agentId }, request, nowMs);
    const shared = this.withAutonomy(prior);
    const next: Extract<Snapshot, { schemaVersion: 5 }> = { ...shared, schemaVersion: 5,
      sizing: shared.schemaVersion === 5 ? shared.sizing : [] };
    const checkpoint: PrivateSizingCheckpoint = { agentId, policy, lastChange: request };
    const index = next.sizing.findIndex((item) => item.agentId === agentId);
    if (index < 0) next.sizing.push(checkpoint); else next.sizing[index] = checkpoint;
    this.reserveCompletion(next); this.fence(prior, operation); this.commit(next);
    return copy(policy);
  }

  /** Only actual autonomous use activates accounting. The legacy ambiguity is
   * assessed once against a pinned history boundary, never reclassified later. */
  async prepareAutonomyAsync(agentId: string, nowMs: number, operation: PrivateBrainStoreOperation = {}): Promise<PrivateAutonomyStatus> {
    this.agent(agentId); privateAutonomyUtcDay(nowMs); operation = { ...operation };
    const prior = this.snapshot; this.fence(prior, operation);
    const original = this.autonomyCheckpoint(agentId);
    if (original?.activation && this.autonomyCounters.has(agentId)) return this.autonomyStatus(agentId, nowMs);
    const checkpoint = copy(original ?? initialPrivateAutonomyCheckpoint(agentId, nowMs));
    if (nowMs < checkpoint.clockHighWaterMs) throw new PrivateAutonomyError("clock_rollback");
    const counter = new PrivateAutonomyCounter(agentId, nowMs, checkpoint.clockHighWaterMs);
    let legacyHoldUntilMs = checkpoint.activation?.legacyHoldUntilMs ?? null;
    const classifyLegacy = (entry: StoredJob): void => {
      if (checkpoint.activation || !isSignal(entry) || entry.job.agentId !== agentId || !entry.job.start || entry.job.callReservation) return;
      // Terminal updatedAt bounds any dispatch by the old one-call service.
      // An interrupted running record is stamped at recovery, conservatively.
      if (entry.job.updatedAt > nowMs) throw new PrivateAutonomyError("clock_rollback");
      const upper = entry.job.updatedAt;
      let until = upper + AUTONOMOUS_TOKEN_COOLDOWN_MS;
      if (privateAutonomyUtcDay(upper) === privateAutonomyUtcDay(nowMs)) until = Math.max(until, nextPrivateAutonomyUtcDay(nowMs));
      if (until > nowMs) legacyHoldUntilMs = Math.max(legacyHoldUntilMs ?? 0, until);
    };
    await this.scan((entry) => {
      if (!isSignal(entry) || entry.job.agentId !== agentId) return;
      if (entry.job.callReservation) {
        if (!checkpoint.activation || entry.job.callReservation.reservedAt > checkpoint.clockHighWaterMs) throw new PrivateAutonomyError("state_unavailable");
        counter.include(entry.job.receipt.signal.chain, entry.job.receipt.signal.assetId, entry.job.callReservation, nowMs);
      } else classifyLegacy(entry);
    }, prior, operation);
    this.fence(prior, operation);
    if (JSON.stringify(this.autonomyCheckpoint(agentId)) !== JSON.stringify(original)) throw new PrivateAutonomyError("revision_conflict");
    // Concurrent cancellation may have advanced a current legacy job timestamp.
    this.snapshot.jobs.forEach(classifyLegacy);
    if (!checkpoint.activation) {
      checkpoint.activation = { at: nowMs, throughOrdinal: this.snapshot.schemaVersion === 1 ? this.snapshot.jobs.length : this.snapshot.nextOrdinal - 1,
        legacyHoldUntilMs };
      checkpoint.clockHighWaterMs = nowMs;
      const next = this.withAutonomy(this.snapshot); this.putAutonomyCheckpoint(next, checkpoint);
      this.reserveCompletion(next); this.fence(prior, operation); this.commit(next);
    }
    if (counter.totalReservationCount !== checkpoint.totalReservationCount) throw new PrivateAutonomyError("state_unavailable");
    this.autonomyCounters.set(agentId, counter);
    return this.autonomyStatus(agentId, nowMs);
  }

  checkSignalAllowance(agentId: string, jobId: string, nowMs: number): PrivateAutonomyCheck {
    const entry = this.findSignal(agentId, jobId); privateAutonomyUtcDay(nowMs);
    const checkpoint = this.autonomyCheckpoint(agentId); const counter = this.autonomyCounters.get(agentId);
    if (!checkpoint?.activation || !counter || entry.job.callReservation) return { allowed: false, reason: "call_allowance_unavailable" };
    if (entry.job.state !== "received" && entry.job.state !== "running") throw new PrivateAutonomyError("revision_conflict");
    return copy(counter.check(checkpoint, entry.job.receipt.signal.chain, entry.job.receipt.signal.assetId, nowMs));
  }

  /** The only provider-dispatch allowance. This single snapshot commit retains
   * the debit with its exact signal job through cancellation, crash and archive.
   * A recovered/existing reservation never permits another provider call. */
  reserveSignalCall(agentId: string, jobId: string, expectedGeneration: number, input: PrivateAutonomyReservationInput,
    operation: PrivateBrainStoreOperation = {}): { created: boolean; job: PrivateSignalJob; reservation: PrivateSignalCallReservation } {
    const prior = this.snapshot; this.fence(prior, operation); const entry = this.findSignal(agentId, jobId);
    if (!isRecord(input) || !exactKeys(input, ["policyRevision", "admission", "nowMs"])
      || !Number.isSafeInteger(input.policyRevision) || input.policyRevision < 0) throw new PrivateAutonomyError("invalid_request");
    const nowMs = input.nowMs; privateAutonomyUtcDay(nowMs);
    if (entry.job.state !== "running" || !entry.job.start || entry.job.generation !== expectedGeneration) throw new PrivateAutonomyError("revision_conflict");
    const checkpoint = this.autonomyCheckpoint(agentId); const counter = this.autonomyCounters.get(agentId);
    if (!checkpoint?.activation || !counter) throw new PrivateAutonomyError("unprepared");
    if (checkpoint.policy.revision !== input.policyRevision) throw new PrivateAutonomyError("revision_conflict");
    if (nowMs < entry.job.updatedAt || counter.status(checkpoint, nowMs).reason === "clock_rollback") throw new PrivateAutonomyError("clock_rollback");
    let admission: ReturnType<typeof parsePrivateSignalAdmission>;
    try { admission = parsePrivateSignalAdmission(input.admission, entry.job.receipt, entry.job.start); }
    catch { throw new PrivateAutonomyError("invalid_request"); }
    const admissionDigest = privateSignalAdmissionDigest(admission);
    if (entry.job.callReservation) {
      if (entry.job.callReservation.admissionDigest !== admissionDigest || entry.job.callReservation.policyRevision !== input.policyRevision)
        throw new PrivateAutonomyError("operation_conflict");
      this.fence(prior, operation);
      return { created: false, job: copy(entry.job), reservation: copy(entry.job.callReservation) };
    }
    const check = counter.check(checkpoint, entry.job.receipt.signal.chain, entry.job.receipt.signal.assetId, nowMs);
    if (!check.allowed) throw new PrivateAutonomyError(check.reason === "call_allowance_unavailable" ? "unprepared" : check.reason);
    const reservation = parsePrivateSignalCallReservation({ version: 1,
      reservationId: privateSignalCallId(this.options.localProfileId, agentId, jobId), reservedAt: nowMs,
      utcDay: privateAutonomyUtcDay(nowMs), policyRevision: checkpoint.policy.revision, dailyCallLimit: checkpoint.policy.dailyCallLimit, admissionDigest },
      { localProfileId: this.options.localProfileId, agentId, jobId });
    const job = parsePrivateSignalJob({ ...entry.job, callReservation: reservation, updatedAt: nowMs });
    const next = this.withAutonomy(this.snapshot);
    const index = next.jobs.findIndex((item) => item.job.jobId === jobId); next.jobs[index] = { ...entry, job };
    if (!Number.isSafeInteger(checkpoint.totalReservationCount + 1)) throw new PrivateAutonomyError("state_unavailable");
    this.putAutonomyCheckpoint(next, { ...copy(checkpoint), clockHighWaterMs: nowMs, totalReservationCount: checkpoint.totalReservationCount + 1 });
    this.reserveCompletion(next); this.fence(prior, operation); this.commit(next);
    try { counter.include(entry.job.receipt.signal.chain, entry.job.receipt.signal.assetId, reservation, nowMs); }
    catch { this.held = true; throw new PrivateAutonomyError("state_unavailable"); }
    return { created: true, job: copy(job), reservation: copy(reservation) };
  }

  private autonomyCheckpoint(agentId: string): PrivateAutonomyCheckpoint | undefined {
    return (this.snapshot.schemaVersion === 4 || this.snapshot.schemaVersion === 5) ? this.snapshot.autonomy.find((item) => item.agentId === agentId) : undefined;
  }
  private withAutonomy(snapshot: Snapshot): Extract<Snapshot, { schemaVersion: 4 | 5 }> {
    if (snapshot.schemaVersion === 4 || snapshot.schemaVersion === 5) return copy(snapshot);
    return { schemaVersion: 4, localProfileId: snapshot.localProfileId, jobs: snapshot.jobs.map((entry, index) => ({ ...copy(entry), ordinal: ordinal(entry, index) })),
      archiveHead: head(snapshot), nextOrdinal: snapshot.schemaVersion === 1 ? snapshot.jobs.length + 1 : snapshot.nextOrdinal, autonomy: [] };
  }
  private putAutonomyCheckpoint(snapshot: Extract<Snapshot, { schemaVersion: 4 | 5 }>, checkpoint: PrivateAutonomyCheckpoint): void {
    const index = snapshot.autonomy.findIndex((entry) => entry.agentId === checkpoint.agentId);
    if (index < 0) snapshot.autonomy.push(copy(checkpoint)); else snapshot.autonomy[index] = copy(checkpoint);
  }
  private initializeAutonomyCounters(nowMs: number): void {
    if (this.snapshot.schemaVersion !== 4 && this.snapshot.schemaVersion !== 5) return;
    for (const checkpoint of this.snapshot.autonomy) if (checkpoint.activation)
      this.autonomyCounters.set(checkpoint.agentId, new PrivateAutonomyCounter(checkpoint.agentId, nowMs, checkpoint.clockHighWaterMs));
  }
  private verifyAutonomyCounters(): void {
    if (this.snapshot.schemaVersion !== 4 && this.snapshot.schemaVersion !== 5) return;
    for (const checkpoint of this.snapshot.autonomy) if (checkpoint.activation
      && this.autonomyCounters.get(checkpoint.agentId)?.totalReservationCount !== checkpoint.totalReservationCount) fail("state_unavailable");
  }
  private collectAutonomyReservation(entry: StoredJob, nowMs: number): void {
    if (!isSignal(entry) || !entry.job.callReservation) return;
    const checkpoint = this.autonomyCheckpoint(entry.job.agentId); const counter = this.autonomyCounters.get(entry.job.agentId);
    if (!checkpoint?.activation || !counter || entry.job.callReservation.reservedAt > checkpoint.clockHighWaterMs
      || entry.job.callReservation.policyRevision > checkpoint.policy.revision) fail("state_unavailable");
    counter.include(entry.job.receipt.signal.chain, entry.job.receipt.signal.assetId, entry.job.callReservation, Math.max(nowMs, checkpoint.clockHighWaterMs));
  }

  /** Bounded newest-first readback. Cursor is the immutable global creation
   * ordinal, never a moving array index or a mutable completion timestamp. */
  async listSignalsAsync(agentId: string, beforeOrdinal?: number, operation: PrivateBrainStoreOperation = {}): Promise<PrivateSignalPage> {
    this.agent(agentId);
    if (beforeOrdinal !== undefined && (!Number.isSafeInteger(beforeOrdinal) || beforeOrdinal < 1)) fail("invalid_request");
    operation = { ...operation }; const prior = this.snapshot; this.fence(prior, operation);
    const ceiling = Math.min(beforeOrdinal ?? Number.MAX_SAFE_INTEGER, prior.schemaVersion === 1 ? prior.jobs.length + 1 : prior.nextOrdinal);
    const selected = new Map<number, StoredSignalJob>();
    const consider = (entry: StoredJob, order: number): void => {
      if (!isSignal(entry) || entry.job.agentId !== agentId || order >= ceiling) return;
      selected.set(order, entry);
      if (selected.size > PRIVATE_SIGNAL_PAGE_SIZE + 1) selected.delete(Math.min(...selected.keys()));
    };
    await this.scan(consider, prior, operation);
    this.fence(prior, operation);
    // Reflect completed/cancelled current jobs after historical IO, while
    // excluding creations newer than this page's captured upper boundary.
    this.snapshot.jobs.forEach((entry, index) => consider(entry, ordinal(entry, index)));
    const ordered = [...selected.entries()].sort(([left], [right]) => right - left);
    const items = ordered.slice(0, PRIVATE_SIGNAL_PAGE_SIZE).map(([order, entry]) => summarizePrivateSignalJob(entry.job, order));
    this.fence(prior, operation);
    return { items, nextBeforeOrdinal: ordered.length > PRIVATE_SIGNAL_PAGE_SIZE ? items.at(-1)!.ordinal : null };
  }

  async readSignalAsync(agentId: string, jobId: string, operation: PrivateBrainStoreOperation = {}): Promise<PrivateSignalJob> {
    this.agent(agentId); if (!isId(jobId)) fail("invalid_request");
    operation = { ...operation }; const prior = this.snapshot; this.fence(prior, operation);
    const current = this.snapshot.jobs.find((entry) => entry.job.jobId === jobId);
    if (current) { if (!isSignal(current) || current.job.agentId !== agentId) fail("job_not_found"); return copy(current.job); }
    let found: StoredJob | undefined;
    await this.scan((entry) => {
      if (entry.job.jobId === jobId) {
        if (found) { this.held = true; fail("state_unavailable"); }
        found = entry;
      }
    }, prior, operation);
    this.fence(prior, operation);
    found = this.snapshot.jobs.find((entry) => entry.job.jobId === jobId) ?? found;
    if (!found || !isSignal(found) || found.job.agentId !== agentId) fail("job_not_found");
    return copy(found.job);
  }

  startSignal(agentId: string, jobId: string, expectedGeneration: number, start: PrivateSignalStart): PrivateSignalJob {
    return this.transitionSignal(agentId, jobId, expectedGeneration, "running", { start });
  }
  completeSignal(agentId: string, jobId: string, expectedGeneration: number, result: PrivateSignalResult): PrivateSignalJob {
    return this.transitionSignal(agentId, jobId, expectedGeneration, "completed", { result });
  }
  holdSignal(agentId: string, jobId: string, expectedGeneration: number, reason: PrivateSignalHoldReason): PrivateSignalJob {
    return this.transitionSignal(agentId, jobId, expectedGeneration, "held", { reason });
  }
  failSignal(agentId: string, jobId: string, expectedGeneration: number, error: PrivateSignalFailure): PrivateSignalJob {
    return this.transitionSignal(agentId, jobId, expectedGeneration, "failed", { error });
  }
  private findSignal(agentId: string, jobId: string): StoredSignalJob {
    this.assertAvailable(); this.agent(agentId); if (!isId(jobId)) fail("invalid_request");
    const entry = this.snapshot.jobs.find((item) => item.job.jobId === jobId);
    if (!entry) fail(head(this.snapshot) ? "state_unavailable" : "job_not_found");
    if (!isSignal(entry) || entry.job.agentId !== agentId) fail("job_not_found");
    return entry;
  }
  private transitionSignal(agentId: string, jobId: string, generation: number,
    state: "running" | "completed" | "held" | "failed",
    fields: { start?: PrivateSignalStart; result?: PrivateSignalResult; reason?: PrivateSignalHoldReason; error?: PrivateSignalFailure }): PrivateSignalJob {
    const entry = this.findSignal(agentId, jobId);
    if (!Number.isSafeInteger(generation) || entry.job.generation !== generation
      || (state === "running" ? entry.job.state !== "received"
        : state === "held" ? entry.job.state !== "received" && entry.job.state !== "running" : entry.job.state !== "running")) fail("revision_conflict");
    if (state === "completed" && this.autonomyCheckpoint(agentId)?.activation && !entry.job.callReservation)
      throw new PrivateAutonomyError("unprepared");
    let job: PrivateSignalJob;
    try { job = parsePrivateSignalJob({ ...entry.job, ...fields, state, generation: generation + 1, updatedAt: Math.max(Date.now(), entry.job.updatedAt) }); }
    catch { fail("invalid_result"); }
    const next = copy(this.snapshot);
    const index = next.jobs.findIndex((item) => item.job.jobId === jobId);
    next.jobs[index] = { ...entry, job };
    this.commit(next); return copy(job);
  }

  async readAsync(agentId: string, jobId: string, operation: PrivateBrainStoreOperation = {}): Promise<PrivateBrainJob> {
    this.agent(agentId); if (!isId(jobId)) fail("invalid_request");
    operation = { ...operation }; const prior = this.snapshot; this.fence(prior, operation);
    const current = this.snapshot.jobs.find((entry) => entry.job.jobId === jobId);
    if (current) { if (current.job.agentId !== agentId || isSignal(current)) fail("job_not_found"); return copy(current.job); }
    let found: StoredJob | undefined;
    await this.scan((entry) => {
      if (entry.job.jobId === jobId) {
        if (found) { this.held = true; fail("state_unavailable"); }
        found = entry;
      }
    }, prior, operation);
    this.fence(prior, operation);
    found = this.snapshot.jobs.find((entry) => entry.job.jobId === jobId) ?? found;
    if (!found || found.job.agentId !== agentId || isSignal(found)) fail("job_not_found");
    return copy(found.job);
  }

  async cancelAsync(agentId: string, jobId: string, operation: PrivateBrainStoreOperation = {}): Promise<PrivateBrainJob> {
    operation = { ...operation }; const prior = this.snapshot; this.fence(prior, operation);
    const entry = this.snapshot.jobs.find((item) => item.job.agentId === agentId && item.job.jobId === jobId);
    // Stop never waits for historical IO. Active jobs can only be in this window.
    if (entry && !isSignal(entry) && active(entry)) { this.fence(prior, operation); return this.cancel(agentId, jobId); }
    return this.readAsync(agentId, jobId, operation);
  }

  async historyAsync(agentId: string, limit = 8, operation: PrivateBrainStoreOperation = {}): Promise<PrivateBrainHistoryEntry[]> {
    this.agent(agentId); this.historyLimit(limit); operation = { ...operation }; const prior = this.snapshot;
    const selected: StoredChatJob[] = [];
    await this.scan((entry, order) => {
      if (isSignal(entry) || entry.job.agentId !== agentId || entry.job.state !== "completed" || limit === 0) return;
      selected.push({ ...entry, ordinal: order });
      selected.sort((a, b) => b.job.updatedAt - a.job.updatedAt || b.ordinal! - a.ordinal!);
      if (selected.length > limit) selected.pop();
    }, prior, operation);
    this.fence(prior, operation); return this.historyResult(selected);
  }

  read(agentId: string, jobId: string): PrivateBrainJob { return copy(this.find(agentId, jobId).job); }

  start(agentId: string, jobId: string): PrivateBrainWork {
    const entry = this.find(agentId, jobId);
    if (entry.job.state !== "queued") fail("revision_conflict");
    const job = this.transition(agentId, jobId, entry.job.generation, "running");
    return { job, text: entry.text };
  }

  complete(agentId: string, jobId: string, expectedGeneration: number, reply: string): PrivateBrainJob {
    if (!isPrivateBrainText(reply)) fail("invalid_result");
    return this.transition(agentId, jobId, expectedGeneration, "completed", reply);
  }

  fail(agentId: string, jobId: string, expectedGeneration: number, error: PrivateBrainJobFailure): PrivateBrainJob {
    if (error !== "provider_unavailable" && error !== "research_unavailable" && error !== "invalid_result") fail("invalid_result");
    return this.transition(agentId, jobId, expectedGeneration, "failed", undefined, error);
  }

  cancel(agentId: string, jobId: string): PrivateBrainJob {
    const { job } = this.find(agentId, jobId);
    if (job.state !== "queued" && job.state !== "running") return copy(job);
    return this.transition(agentId, jobId, job.generation, "cancelled");
  }

  cancelAgent(agentId: string): void {
    this.assertAvailable(); this.agent(agentId);
    const next = copy(this.snapshot);
    let changed = false;
    for (const entry of next.jobs) {
      if (entry.job.agentId === agentId && active(entry)) {
        entry.job = { ...entry.job, generation: entry.job.generation + 1, state: "cancelled",
          updatedAt: Math.max(Date.now(), entry.job.updatedAt) };
        changed = true;
      }
    }
    if (changed) this.commit(next);
  }

  /** Daemon-private completed context only. Never use this accessor in status IPC. */
  history(agentId: string, limit = 8): PrivateBrainHistoryEntry[] {
    this.assertAvailable(); this.agent(agentId); this.historyLimit(limit);
    if (head(this.snapshot)) fail("state_unavailable");
    const selected = this.snapshot.jobs.map((entry, index) => ({ ...entry, ordinal: ordinal(entry, index) }))
      .filter((entry): entry is StoredChatJob & { ordinal: number } => !isSignal(entry) && entry.job.agentId === agentId && entry.job.state === "completed")
      .sort((a, b) => b.job.updatedAt - a.job.updatedAt || b.ordinal - a.ordinal).slice(0, limit);
    return this.historyResult(selected);
  }
  private historyLimit(limit: number): void {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 16) fail("invalid_request");
  }
  private historyResult(entries: StoredChatJob[]): PrivateBrainHistoryEntry[] {
    const result: PrivateBrainHistoryEntry[] = [];
    for (const entry of entries) {
      const item = { jobId: entry.job.jobId, text: entry.text, reply: entry.job.reply!,
        modelRevision: entry.job.modelRevision, completedAt: entry.job.updatedAt };
      if (Buffer.byteLength(JSON.stringify([...result, item]), "utf8") > MAX_HISTORY_BYTES) break;
      result.push(item);
    }
    return result.reverse();
  }

  /** Throws and permanently holds this instance after ambiguous ownership/IO. */
  assertAvailable(): void {
    if (this.held) fail("state_unavailable");
    try { this.storage.assertAvailable(); }
    catch { fail("state_unavailable"); }
  }

  close(): void { this.storage.close(); }

  private agent(agentId: string): void {
    if (!isId(agentId) || !this.options.agentIds.includes(agentId)) fail("unknown_agent");
  }
  private find(agentId: string, jobId: string): StoredChatJob {
    this.assertAvailable(); this.agent(agentId);
    if (!isId(jobId)) fail("invalid_request");
    const entry = this.snapshot.jobs.find((item) => item.job.jobId === jobId && item.job.agentId === agentId);
    if (!entry) fail(head(this.snapshot) ? "state_unavailable" : "job_not_found");
    if (isSignal(entry)) fail("job_not_found");
    return entry;
  }
  private transition(agentId: string, jobId: string, generation: number, state: "running" | "completed" | "failed" | "cancelled",
    reply?: string, error?: PrivateBrainJobFailure): PrivateBrainJob {
    const entry = this.find(agentId, jobId);
    if (entry.job.generation !== generation || !Number.isSafeInteger(generation)
      || (state === "running" ? entry.job.state !== "queued"
        : state === "cancelled" ? entry.job.state !== "queued" && entry.job.state !== "running"
          : entry.job.state !== "running")) fail("revision_conflict");
    const next = copy(this.snapshot);
    const target = next.jobs.find((item) => item.job.jobId === jobId)!;
    if (isSignal(target)) fail("job_not_found");
    target.job = { ...target.job, state, generation: generation + 1, updatedAt: Math.max(Date.now(), target.job.updatedAt),
      ...(reply !== undefined ? { reply } : {}), ...(error !== undefined ? { error } : {}) };
    parsePrivateBrainJob(target.job);
    this.commit(next);
    return copy(target.job);
  }

  private decode(value: unknown): Snapshot {
    if (!isRecord(value) || value.localProfileId !== this.options.localProfileId) fail("state_unavailable");
    if (value.schemaVersion === 1 && exactKeys(value, ["schemaVersion", "localProfileId", "jobs"])) {
      return { schemaVersion: 1, localProfileId: this.options.localProfileId, jobs: this.decodeJobs(value.jobs, false) };
    }
    if ((value.schemaVersion !== 2 && value.schemaVersion !== 3 && value.schemaVersion !== 4 && value.schemaVersion !== 5)
      || !exactKeys(value, ["schemaVersion", "localProfileId", "jobs", "archiveHead", "nextOrdinal", ...((value.schemaVersion === 4 || value.schemaVersion === 5) ? ["autonomy"] : []), ...(value.schemaVersion === 5 ? ["sizing"] : [])])
      || !Number.isSafeInteger(value.nextOrdinal) || Number(value.nextOrdinal) < 1) fail("state_unavailable");
    const jobs = this.decodeJobs(value.jobs, true, false, value.schemaVersion !== 2); const archiveHead = workingArchiveHead(value.archiveHead);
    if ((archiveHead?.endSequence ?? 0) + jobs.length !== Number(value.nextOrdinal) - 1
      || jobs.some((entry) => entry.ordinal! >= Number(value.nextOrdinal))) fail("state_unavailable");
    const common = { localProfileId: this.options.localProfileId, jobs, archiveHead, nextOrdinal: Number(value.nextOrdinal) };
    if (value.schemaVersion !== 4 && value.schemaVersion !== 5) return { schemaVersion: value.schemaVersion, ...common };
    if (!Array.isArray(value.autonomy) || value.autonomy.length > this.options.agentIds.length) fail("state_unavailable");
    const autonomy = value.autonomy.map((item: unknown) => parsePrivateAutonomyCheckpoint(item, common.nextOrdinal));
    if (new Set(autonomy.map((item) => item.agentId)).size !== autonomy.length
      || autonomy.some((item) => !this.options.agentIds.includes(item.agentId))) fail("state_unavailable");
    const operations = autonomy.flatMap((item) => item.lastPolicyChange ? [item.lastPolicyChange.operationId] : []);
    if (new Set(operations).size !== operations.length) fail("state_unavailable");
    if (value.schemaVersion === 4) return { schemaVersion: 4, ...common, autonomy };
    if (!Array.isArray(value.sizing) || value.sizing.length > this.options.agentIds.length) fail("state_unavailable");
    const sizing = value.sizing.map((item: unknown) => {
      if (!isRecord(item) || typeof item.agentId !== "string" || !this.options.agentIds.includes(item.agentId)) fail("state_unavailable");
      return parsePrivateSizingCheckpoint(item, { localProfileId: this.options.localProfileId, agentId: item.agentId });
    });
    if (new Set(sizing.map((item) => item.agentId)).size !== sizing.length
      || new Set(sizing.map((item) => item.lastChange.operationId)).size !== sizing.length) fail("state_unavailable");
    return { schemaVersion: 5, ...common, autonomy, sizing };
  }

  private decodeJobs(value: unknown, ordered: boolean, terminalOnly = false, allowSignals = false): StoredJob[] {
    if (!Array.isArray(value) || value.length > MAX_PRIVATE_BRAIN_JOBS) fail("state_unavailable");
    const ids = new Set<string>(); let previousOrdinal = 0;
    return value.map((entry): StoredJob => {
      if (isRecord(entry) && entry.kind === "signal_decision") {
        if (!allowSignals || !exactKeys(entry, ordered ? ["kind", "job", "digest", "ordinal"] : ["kind", "job", "digest"])) fail("state_unavailable");
        const job = parsePrivateSignalJob(entry.job);
        if (job.receipt.localProfileId !== this.options.localProfileId || !this.options.agentIds.includes(job.agentId)
          || ids.has(job.jobId) || entry.digest !== privateSignalReceiptDigest(job.receipt)
          || (terminalOnly && (job.state === "received" || job.state === "running"))) fail("state_unavailable");
        if (ordered) {
          if (!Number.isSafeInteger(entry.ordinal) || Number(entry.ordinal) <= previousOrdinal) fail("state_unavailable");
          previousOrdinal = Number(entry.ordinal);
        }
        ids.add(job.jobId);
        return { kind: "signal_decision", job, digest: entry.digest as string, ...(ordered ? { ordinal: Number(entry.ordinal) } : {}) };
      }
      if (!isRecord(entry) || !exactKeys(entry, ordered ? ["job", "text", "digest", "ordinal"] : ["job", "text", "digest"])
        || !isPrivateBrainText(entry.text)) fail("state_unavailable");
      const job = parsePrivateBrainJob(entry.job);
      if (!this.options.agentIds.includes(job.agentId) || ids.has(job.jobId)
        || entry.digest !== digest(this.options.localProfileId, job, entry.text)
        || (terminalOnly && (job.state === "queued" || job.state === "running"))) fail("state_unavailable");
      if (ordered) {
        if (!Number.isSafeInteger(entry.ordinal) || Number(entry.ordinal) <= previousOrdinal) fail("state_unavailable");
        previousOrdinal = Number(entry.ordinal);
      }
      ids.add(job.jobId);
      return { job, text: entry.text, digest: entry.digest as string, ...(ordered ? { ordinal: Number(entry.ordinal) } : {}) };
    });
  }
  private request(input: PrivateBrainChatCreateRequest): PrivateBrainChatCreateRequest {
    let request: PrivateBrainChatCreateRequest;
    try { const parsed = parsePrivateBrainRequest(input); if (parsed.action !== "chat_create") fail("invalid_request"); request = copy(parsed); }
    catch { fail("invalid_request"); }
    this.assertAvailable();
    if (request.localProfileId !== this.options.localProfileId) fail("profile_conflict");
    this.agent(request.agentId); return request;
  }
  private replay(previous: StoredJob, request: PrivateBrainChatCreateRequest): PrivateBrainJob {
    if (isSignal(previous)) fail("job_conflict");
    if (previous.job.agentId !== request.agentId || previous.job.originalInstanceId !== request.instanceId
      || previous.text !== request.text) fail("job_conflict");
    return copy(previous.job);
  }
  private newEntry(request: PrivateBrainChatCreateRequest, modelRevision: number): StoredChatJob {
    if (request.instanceId !== this.options.instanceId) fail("instance_conflict");
    if (!Number.isSafeInteger(modelRevision) || modelRevision < 1) fail("model_locked");
    const now = Date.now();
    const job: PrivateBrainJob = { jobId: request.jobId, agentId: request.agentId, originalInstanceId: request.instanceId,
      modelRevision, generation: 1, state: "queued", createdAt: now, updatedAt: now };
    return { job, text: request.text, digest: digest(this.options.localProfileId, job, request.text) };
  }
  private push(next: Snapshot, entry: StoredJob): void {
    if (next.schemaVersion !== 1) {
      if (!Number.isSafeInteger(next.nextOrdinal + 1)) fail("journal_full");
      entry.ordinal = next.nextOrdinal++;
    }
    next.jobs.push(entry);
  }
  private reserveCompletion(next: Snapshot): void {
    // Text and reply limits already count JSON escaping. Reserve a full bounded
    // reply for every live job so admitted work can always reach a terminal state.
    const reserved = Buffer.byteLength(JSON.stringify(next), "utf8")
      + next.jobs.filter(active).reduce((total, entry) => total + (isSignal(entry) ? MAX_PRIVATE_SIGNAL_JOB_BYTES : MAX_PRIVATE_BRAIN_TEXT_BYTES) + 256, 0);
    if (reserved > MAX_SNAPSHOT_BYTES) fail("journal_full");
  }
  private recoverInterrupted(): void {
    const interrupted = copy(this.snapshot); let changed = false;
    for (const entry of interrupted.jobs) if (active(entry)) {
      entry.job = { ...entry.job, state: "interrupted", generation: entry.job.generation + 1,
        updatedAt: Math.max(Date.now(), entry.job.updatedAt) }; changed = true;
    }
    if (changed) this.commit(interrupted); else this.assertAvailable();
  }
  private fence(prior: Snapshot, operation: PrivateBrainStoreOperation): void {
    this.assertAvailable();
    const before = head(prior); const current = head(this.snapshot);
    if (before?.digest !== current?.digest || before?.endSequence !== current?.endSequence) fail("revision_conflict");
    if (operation.signal?.aborted) fail("cancelled"); operation.guard?.();
    this.assertAvailable();
    const after = head(this.snapshot);
    if (before?.digest !== after?.digest || before?.endSequence !== after?.endSequence) fail("revision_conflict");
    if (operation.signal?.aborted) fail("cancelled");
  }
  private scheduleYield(): void {
    if (this.yieldScheduled || !this.yieldQueue.length) return;
    this.yieldScheduled = true;
    setImmediate(() => {
      const resume = this.yieldQueue.shift(); this.yieldScheduled = false;
      this.scheduleYield(); resume?.();
    });
  }
  private async pause(prior: Snapshot, operation: PrivateBrainStoreOperation): Promise<void> {
    this.fence(prior, operation); if (this.yieldQueue.length >= 16) fail("busy");
    await new Promise<void>((resolve) => { this.yieldQueue.push(resolve); this.scheduleYield(); });
    this.fence(prior, operation);
  }
  private async scan(visit: (entry: StoredJob, order: number) => void, prior: Snapshot, operation: PrivateBrainStoreOperation): Promise<void> {
    await this.pause(prior, operation);
    let current = head(prior);
    const tailIds = new Set(prior.jobs.map((entry) => entry.job.jobId));
    const tailOrdinals = new Set(prior.jobs.map((entry, index) => ordinal(entry, index)));
    prior.jobs.forEach((entry, index) => visit(entry, ordinal(entry, index)));
    while (current) {
      await this.pause(prior, operation);
      let segment;
      try { segment = this.archive.read(current); }
      catch { this.held = true; fail("state_unavailable"); }
      this.fence(prior, operation);
      for (const entry of segment.records) {
        if (prior.schemaVersion === 1 || entry.ordinal! >= prior.nextOrdinal || (prior.schemaVersion === 2 && isSignal(entry))
          || tailIds.has(entry.job.jobId) || tailOrdinals.has(entry.ordinal!)) { this.held = true; fail("state_unavailable"); }
        visit(entry, entry.ordinal!);
      }
      current = segment.previous;
    }
    this.fence(prior, operation);
  }

  private commit(next: Snapshot): void {
    try { this.storage.commit(next); this.snapshot = next; }
    catch (error: unknown) {
      if (error instanceof OwnedJsonSnapshotError && error.code === "snapshot_too_large") fail("journal_full");
      fail("state_unavailable");
    }
  }
}
