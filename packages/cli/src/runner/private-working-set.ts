/** Private research history and deterministic references. Never execution authority. */
import * as path from "node:path";
import * as fs from "node:fs";
import { WorkingArchive, WORKING_ARCHIVE_PREFIX, workingArchiveHead, type WorkingArchiveHead } from "./private-working-archive.js";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot, OwnedJsonSnapshotError } from "./owned-json-snapshot.js";
import { isId } from "./protocol.js";
import { assetRef, assessFreshness, loadSnapshot, normalizeResearchResponse,
  type DiscoveryObservation, type ResearchAssessment, type ResearchAssetRef, type ResearchNormalization,
  type ResearchScope, type ResearchSnapshot } from "./private-research-evidence.js";
import type { PrivateResearchReceipt } from "./private-research.js";
import { runnerResearchRequestDigest, type RunnerResearchChain, type RunnerResearchRequest } from "@balchemyai/agent-sdk";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_WORKING_SET_FILE = "private-research-working-set.json";
export const PRIVATE_WORKING_SET_MARKER = "private-research-working-set.initialized";
export const MAX_WORKING_SET_RECORDS = 128;
export const MAX_WORKING_SET_BYTES = 8 * 1024 * 1024;
export const MAX_WORKING_ARCHIVE_BYTES = MAX_WORKING_SET_BYTES + 1024;
export const MAX_WORKING_FOCUS_REFS = 24;
type AcceptedEvidence = Exclude<ResearchNormalization, { kind: "invalid_report" }>;
type QueryScope = Pick<ResearchScope, "localAgentId" | "conversationId">;
export type LocalResearchFailureReason = "transport_unavailable" | "invalid_response";
export interface LocalResearchFailureMarker {
  readonly version: 1; readonly scope: ResearchScope; readonly jobId: string; readonly requestId: string;
  readonly request: RunnerResearchRequest; readonly failedAt: string; readonly reason: LocalResearchFailureReason;
  readonly failureDigest: string;
}
interface StoredReceipt { kind: "receipt"; jobId: string; requestId: string; snapshot: ResearchSnapshot }
interface StoredFailure { kind: "local_failure"; jobId: string; requestId: string; marker: LocalResearchFailureMarker }
type StoredRecord = StoredReceipt | StoredFailure;
interface Snapshot { schemaVersion: 1 | 2 | 3; localProfileId: string; records: StoredRecord[]; archiveHead?: WorkingArchiveHead | null }
export interface WorkingSetRecord {
  readonly sequence: number; readonly jobId: string; readonly requestId: string;
  readonly evidence: AcceptedEvidence | Readonly<{ kind: "local_failure"; marker: LocalResearchFailureMarker }>;
  readonly assessment?: ResearchAssessment;
}
export interface WorkingSetList {
  readonly chain: RunnerResearchChain; readonly latestAttempt: WorkingSetRecord;
  /** The latest successful report remains visible after a failed attempt, as context only. */
  readonly context?: WorkingSetRecord;
}
export interface WorkingSetRetention {
  readonly totalRecords: number; readonly archivedRecords: number; readonly omittedRecords: number;
}
export interface WorkingSetOperation { signal?: AbortSignal; guard?: () => void }
export interface WorkingSetReadOptions { readonly focusRefIds?: readonly string[] }
export interface WorkingSetHistoryPage {
  readonly scope: ResearchScope; readonly records: readonly WorkingSetRecord[];
  readonly beforeSequence: number | null; readonly nextBeforeSequence: number | null;
  readonly executionAuthority: "not_authorized_by_report";
}
export interface WorkingSetView {
  readonly scope: ResearchScope; readonly records: readonly WorkingSetRecord[];
  readonly activeLists: readonly WorkingSetList[];
  readonly retention?: WorkingSetRetention;
  readonly executionAuthority: "not_authorized_by_report";
}
export interface WorkingSetAsset {
  readonly asset: ResearchAssetRef;
  readonly discovery?: Readonly<{ sequence: number; ordinal: number; observation: DiscoveryObservation;
    assessment: ResearchAssessment; contextOnly: boolean }>;
  readonly candidateReport?: WorkingSetRecord; readonly riskReport?: WorkingSetRecord;
}
export type WorkingSetSelector =
  | { kind: "all"; chain?: RunnerResearchChain }
  | { kind: "ordinal"; ordinal: number; chain?: RunnerResearchChain }
  | { kind: "symbol"; symbol: string; chain?: RunnerResearchChain }
  | { kind: "lowest"; metric: "liquidityUsd" | "marketCapUsd"; chain?: RunnerResearchChain }
  | { kind: "refId"; refId: string };
export type WorkingSetSelection =
  | Readonly<{ kind: "resolved"; assets: readonly WorkingSetAsset[]; executionAuthority: "not_authorized_by_report" }>
  | Readonly<{ kind: "unresolved"; reason: "no_active_list" | "chain_ambiguous" | "held" | "not_found"
    | "symbol_ambiguous" | "metric_missing" | "tie" | "ordinal_out_of_range";
    options: readonly ResearchAssetRef[]; executionAuthority: "not_authorized_by_report" }>;
export interface PrivateWorkingSetOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** The caller retains the daemon's existing exclusive writer. No second lock is acquired. */
  assertAvailable(): void;
}
export type WorkingSetErrorCode = "invalid_request" | "invalid_evidence" | "scope_mismatch" | "record_conflict" | "journal_full" | "state_unavailable" | "requires_async" | "operation_cancelled" | "operation_busy";
export class PrivateWorkingSetError extends Error {
  constructor(readonly code: WorkingSetErrorCode) { super(`Private working set ${code}`); this.name = "PrivateWorkingSetError"; }
}
function fail(code: WorkingSetErrorCode): never { throw new PrivateWorkingSetError(code); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || !keys.every((key) => Object.hasOwn(value, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((field) => !("value" in field) || !field.enumerable)) fail("invalid_request");
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
// Identity-only memoization for immutable validated facts. Never persists trust,
// skips archive validation, or reuses an old freshness assessment.
const validatedRecords = new WeakSet<WorkingSetRecord>();
function validated<T extends WorkingSetRecord>(value: T): T {
  frozen(value); validatedRecords.add(value); return value;
}
function key(record: StoredRecord): string {
  const scope = storedScope(record);
  return JSON.stringify([scope.localAgentId, scope.conversationId, record.jobId, record.requestId]);
}
function storedScope(record: StoredRecord): ResearchScope { return record.kind === "receipt" ? record.snapshot.scope : record.marker.scope; }
function storedRequest(record: StoredRecord): RunnerResearchRequest {
  return record.kind === "receipt" ? record.snapshot.receipt.expectedTarget.request : record.marker.request;
}
function storedDigest(record: StoredRecord): string { return record.kind === "receipt" ? record.snapshot.snapshotDigest : record.marker.failureDigest; }
function record(entry: StoredRecord, sequence: number, now: number): WorkingSetRecord {
  const evidence = entry.kind === "receipt" ? loadSnapshot(JSON.stringify(entry.snapshot), entry.snapshot.scope)
    : { kind: "local_failure" as const, marker: failureMarker(entry.marker, entry.marker.scope) };
  return validated({ sequence, jobId: entry.jobId, requestId: entry.requestId, evidence,
    ...(evidence.kind === "report" ? { assessment: assessFreshness(evidence.report, now) } : {}) });
}
export function workingSetRecordScope(value: WorkingSetRecord): ResearchScope {
  return value.evidence.kind === "local_failure" ? value.evidence.marker.scope : value.evidence.snapshot.scope;
}
export function workingSetRecordRequest(value: WorkingSetRecord): RunnerResearchRequest {
  return value.evidence.kind === "local_failure" ? value.evidence.marker.request : value.evidence.snapshot.receipt.expectedTarget.request;
}
export function workingSetRecordDigest(value: WorkingSetRecord): string {
  return value.evidence.kind === "local_failure" ? value.evidence.marker.failureDigest : value.evidence.snapshot.snapshotDigest;
}
function failureDigest(value: Omit<LocalResearchFailureMarker, "failureDigest">): string {
  return createHash("sha256").update(JSON.stringify(["balchemy.local-research-failure.v1", value.version,
    value.scope.localProfileId, value.scope.localAgentId, value.scope.conversationId, value.jobId, value.requestId,
    runnerResearchRequestDigest(value.request), value.failedAt, value.reason])).digest("hex");
}
function failureMarker(value: unknown, expected: ResearchScope): LocalResearchFailureMarker {
  exact(value, ["version", "scope", "jobId", "requestId", "request", "failedAt", "reason", "failureDigest"]);
  exact(value.scope, ["localProfileId", "localAgentId", "conversationId"]);
  if (Object.values(value.scope).some((id) => !isId(id)) || value.version !== 1 || !isId(value.jobId) || !isId(value.requestId)
    || typeof value.failedAt !== "string" || value.failedAt.length !== 24 || !Number.isFinite(Date.parse(value.failedAt))
    || new Date(value.failedAt).toISOString() !== value.failedAt || typeof value.reason !== "string"
    || !["transport_unavailable", "invalid_response"].includes(value.reason)) fail("invalid_evidence");
  const scope = { localProfileId: String(value.scope.localProfileId), localAgentId: String(value.scope.localAgentId), conversationId: String(value.scope.conversationId) };
  if (scope.localProfileId !== expected.localProfileId || scope.localAgentId !== expected.localAgentId || scope.conversationId !== expected.conversationId) fail("scope_mismatch");
  try { runnerResearchRequestDigest(value.request as RunnerResearchRequest); } catch { fail("invalid_evidence"); }
  const content = { version: 1 as const, scope, jobId: value.jobId, requestId: value.requestId, request: structuredClone(value.request) as RunnerResearchRequest,
    failedAt: value.failedAt, reason: value.reason as LocalResearchFailureReason };
  const digest = failureDigest(content); if (value.failureDigest !== digest) fail("invalid_evidence");
  return frozen({ ...content, failureDigest: digest });
}
/** Revalidates either honest acquisition outcome; local failures never acquire a server receipt. */
export function validateWorkingSetRecord(value: WorkingSetRecord, expectedScope: ResearchScope, nowMs: number): WorkingSetRecord {
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !isId(value.jobId) || !isId(value.requestId) || !Number.isFinite(nowMs)) fail("invalid_evidence");
  exact(expectedScope, ["localProfileId", "localAgentId", "conversationId"]);
  if (Object.values(expectedScope).some((id) => !isId(id))) fail("scope_mismatch");
  const known = validatedRecords.has(value);
  if (known) {
    const actual = workingSetRecordScope(value);
    if (actual.localProfileId !== expectedScope.localProfileId || actual.localAgentId !== expectedScope.localAgentId
      || actual.conversationId !== expectedScope.conversationId) fail("scope_mismatch");
  }
  const evidence = known ? value.evidence : value.evidence.kind === "local_failure"
    ? { kind: "local_failure" as const, marker: failureMarker(value.evidence.marker, expectedScope) }
    : loadSnapshot(JSON.stringify(value.evidence.snapshot), expectedScope);
  if (evidence.kind === "local_failure" && (evidence.marker.jobId !== value.jobId || evidence.marker.requestId !== value.requestId)) fail("invalid_evidence");
  return validated({ sequence: value.sequence, jobId: value.jobId, requestId: value.requestId, evidence,
    ...(evidence.kind === "report" ? { assessment: assessFreshness(evidence.report, nowMs) } : {}) });
}
const authority = "not_authorized_by_report" as const;
const ASYNC_OPEN = Symbol("working-set async open");
interface HistoryRow { entry: StoredRecord; sequence: number; archived: boolean }

export class PrivateWorkingSetStore {
  private readonly options: PrivateWorkingSetOptions;
  private readonly agentList: string[];
  private readonly storage: OwnedJsonSnapshot<Snapshot>;
  private snapshot: Snapshot;
  private readonly archive: WorkingArchive<StoredRecord>;
  private held = false;
  private readonly yieldQueue: Array<() => void> = [];
  private yieldScheduled = false;

  constructor(options: PrivateWorkingSetOptions, asynchronous?: typeof ASYNC_OPEN) {
    if (!isId(options.localProfileId) || !Array.isArray(options.agentIds) || options.agentIds.length < 1
      || options.agentIds.length > 64 || options.agentIds.some((id) => !isId(id))
      || new Set(options.agentIds).size !== options.agentIds.length || typeof options.assertAvailable !== "function"
      || typeof options.directory !== "string" || !path.isAbsolute(options.directory)) fail("invalid_request");
    this.agentList = [...options.agentIds]; this.options = { ...options, agentIds: this.agentList };
    this.snapshot = { schemaVersion: 2, localProfileId: options.localProfileId, records: [] };
    this.archive = new WorkingArchive({ directory: options.directory, localProfileId: options.localProfileId,
      maximumBytes: MAX_WORKING_ARCHIVE_BYTES, maximumRecords: MAX_WORKING_SET_RECORDS,
      assertAvailable: () => this.storage.assertAvailable(), decodeRecords: (records) => this.decode({ schemaVersion: 2,
        localProfileId: this.options.localProfileId, records }).records });
    let storage: OwnedJsonSnapshot<Snapshot> | undefined;
    try {
      options.assertAvailable();
      if (!fs.existsSync(path.join(options.directory, PRIVATE_WORKING_SET_FILE))
        && !fs.existsSync(path.join(options.directory, PRIVATE_WORKING_SET_MARKER))
        && fs.readdirSync(options.directory).some((name) => name.startsWith(WORKING_ARCHIVE_PREFIX))) fail("state_unavailable");
      storage = new OwnedJsonSnapshot({ directory: options.directory, snapshotFile: PRIVATE_WORKING_SET_FILE,
        markerFile: PRIVATE_WORKING_SET_MARKER, marker: { schemaVersion: 1, localProfileId: options.localProfileId },
        initial: this.snapshot, maximumBytes: MAX_WORKING_SET_BYTES, decode: (value) => this.decode(value),
        assertAvailable: () => this.options.assertAvailable() });
      this.storage = storage; this.snapshot = storage.read();
      if (this.snapshot.archiveHead && asynchronous !== ASYNC_OPEN) fail("requires_async");
    } catch (error: unknown) { storage?.close();
      if (error instanceof PrivateWorkingSetError && error.code === "requires_async") throw error;
      fail("state_unavailable");
    }
  }

  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.agentList, agentId); }
  static async open(options: PrivateWorkingSetOptions, operation: WorkingSetOperation = {}): Promise<PrivateWorkingSetStore> {
    operation = { ...operation };
    options = { ...options, agentIds: [...options.agentIds] };
    if (operation.signal?.aborted) fail("operation_cancelled"); operation.guard?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (operation.signal?.aborted) fail("operation_cancelled"); operation.guard?.();
    const store = new PrivateWorkingSetStore(options, ASYNC_OPEN);
    try { await store.scanAsync(() => {}, store.snapshot, operation); return store; }
    catch (error: unknown) { store.close(); throw error; }
  }
  /** Local capability only: never serialize this callback as evidence/authority. */
  captureCheckpointGuard(): () => void {
    this.assertAvailable(); const prior = this.snapshot; return () => this.fence(prior, {});
  }
  private fence(prior: Snapshot, operation: WorkingSetOperation): void {
    this.assertAvailable(); if (this.snapshot !== prior) fail("record_conflict");
    if (operation.signal?.aborted) fail("operation_cancelled"); operation.guard?.();
    this.assertAvailable(); if (this.snapshot !== prior) fail("record_conflict");
    if (operation.signal?.aborted) fail("operation_cancelled");
  }
  private assertSynchronous(): void { this.assertAvailable(); if (this.snapshot.archiveHead) fail("requires_async"); }
  private scheduleYield(): void {
    if (this.yieldScheduled || !this.yieldQueue.length) return;
    this.yieldScheduled = true;
    setImmediate(() => {
      const resume = this.yieldQueue.shift(); this.yieldScheduled = false;
      // Scheduling from this callback defers the next continuation until a new
      // event-loop turn, allowing socket polling between concurrent scan chunks.
      this.scheduleYield(); resume?.();
    });
  }
  private async pause(prior: Snapshot, operation: WorkingSetOperation): Promise<void> {
    this.fence(prior, operation);
    if (this.yieldQueue.length >= 16) fail("operation_busy");
    await new Promise<void>((resolve) => { this.yieldQueue.push(resolve); this.scheduleYield(); });
    this.fence(prior, operation);
  }
  private async scanAsync(visit: (row: HistoryRow) => void, prior: Snapshot, operation: WorkingSetOperation): Promise<void> {
    this.fence(prior, operation); let head = prior.archiveHead ?? null;
    await this.pause(prior, operation);
    for (let i = prior.records.length - 1; i >= 0; i--) visit({ entry: prior.records[i]!, sequence: (head?.endSequence ?? 0) + i + 1, archived: false });
    while (head) {
      await this.pause(prior, operation);
      let segment;
      try { segment = this.archive.read(head); } catch { this.held = true; fail("state_unavailable"); }
      this.fence(prior, operation);
      for (let i = segment.records.length - 1; i >= 0; i--) visit({ entry: segment.records[i]!, sequence: (segment.previous?.endSequence ?? 0) + i + 1, archived: true });
      head = segment.previous;
    }
    this.fence(prior, operation);
  }

  /** Exact scoped job/request replay is read-only and does not move an active list. */
  append(input: QueryScope & { jobId: string; requestId: string; receipt: PrivateResearchReceipt }, guard: () => void): Readonly<Omit<StoredReceipt, "kind"> & { sequence: number }> {
    if (typeof guard !== "function") fail("invalid_request");
    const result = this.appendRecord(this.receiptEntry(input), guard);
    if (result.kind !== "receipt") fail("record_conflict");
    const { kind: _kind, ...receipt } = result; return frozen(receipt);
  }
  private receiptEntry(input: Parameters<PrivateWorkingSetStore["append"]>[0]): StoredReceipt {
    exact(input, ["localAgentId", "conversationId", "jobId", "requestId", "receipt"]);
    const scope = this.scope({ localAgentId: input.localAgentId, conversationId: input.conversationId });
    if (!isId(input.jobId) || !isId(input.requestId)) fail("invalid_request");
    this.assertAvailable();
    const evidence = normalizeResearchResponse({ scope, receipt: input.receipt });
    if (evidence.kind === "invalid_report") fail("invalid_evidence");
    const entry: StoredReceipt = { kind: "receipt", jobId: input.jobId, requestId: input.requestId, snapshot: evidence.snapshot };
    return entry;
  }
  async appendAsync(input: Parameters<PrivateWorkingSetStore["append"]>[0], guard: () => void, signal?: AbortSignal): Promise<ReturnType<PrivateWorkingSetStore["append"]>> {
    if (typeof guard !== "function") fail("invalid_request");
    const result = await this.appendRecordAsync(this.receiptEntry(input), { guard, signal });
    if (result.kind !== "receipt") fail("record_conflict");
    const { kind: _kind, ...receipt } = result; return frozen(receipt);
  }

  appendFailure(input: QueryScope & { jobId: string; requestId: string; request: RunnerResearchRequest;
    failedAt: string; reason: LocalResearchFailureReason }, guard: () => void): Readonly<StoredFailure & { sequence: number }> {
    if (typeof guard !== "function") fail("invalid_request");
    const result = this.appendRecord(this.failureEntry(input), guard);
    if (result.kind !== "local_failure") fail("record_conflict"); return result;
  }
  private failureEntry(input: Parameters<PrivateWorkingSetStore["appendFailure"]>[0]): StoredFailure {
    exact(input, ["localAgentId", "conversationId", "jobId", "requestId", "request", "failedAt", "reason"]);
    const scope = this.scope({ localAgentId: input.localAgentId, conversationId: input.conversationId });
    if (!isId(input.jobId) || !isId(input.requestId)) fail("invalid_request");
    this.assertAvailable();
    try { runnerResearchRequestDigest(input.request); } catch { fail("invalid_evidence"); }
    if (typeof input.failedAt !== "string" || input.failedAt.length !== 24 || !Number.isFinite(Date.parse(input.failedAt))
      || new Date(input.failedAt).toISOString() !== input.failedAt
      || (input.reason !== "transport_unavailable" && input.reason !== "invalid_response")) fail("invalid_evidence");
    const content = { version: 1 as const, scope, jobId: input.jobId, requestId: input.requestId,
      request: structuredClone(input.request), failedAt: input.failedAt, reason: input.reason };
    const marker = failureMarker({ ...content, failureDigest: failureDigest(content) }, scope);
    return { kind: "local_failure", jobId: input.jobId, requestId: input.requestId, marker };
  }
  async appendFailureAsync(input: Parameters<PrivateWorkingSetStore["appendFailure"]>[0], guard: () => void, signal?: AbortSignal): Promise<ReturnType<PrivateWorkingSetStore["appendFailure"]>> {
    if (typeof guard !== "function") fail("invalid_request");
    const result = await this.appendRecordAsync(this.failureEntry(input), { guard, signal });
    if (result.kind !== "local_failure") fail("record_conflict"); return result;
  }

  private *historyNewest(): Generator<HistoryRow> {
    this.assertSynchronous();
    for (let i = this.snapshot.records.length - 1; i >= 0; i--) yield { entry: this.snapshot.records[i]!, sequence: i + 1, archived: false };
  }
  private verifyHistory(): void { for (const _entry of this.historyNewest()) { /* Validate every committed segment, without retaining payloads. */ } }
  private appendRecord(entry: StoredRecord, guard: () => void): Readonly<StoredRecord & { sequence: number }> {
    this.assertSynchronous();
    let replay: { entry: StoredRecord; sequence: number } | undefined;
    for (const prior of this.historyNewest()) if (key(prior.entry) === key(entry)) {
      if (replay) { this.held = true; fail("state_unavailable"); }
      replay = prior;
    }
    if (replay) {
      if (replay.entry.kind !== entry.kind || storedDigest(replay.entry) !== storedDigest(entry)) fail("record_conflict");
      return frozen({ ...structuredClone(replay.entry), sequence: replay.sequence });
    }
    const prior = this.snapshot; const previous = prior.archiveHead ?? null;
    const sequence = (previous?.endSequence ?? 0) + prior.records.length + 1;
    if (!Number.isSafeInteger(sequence)) fail("journal_full");
    const next: Snapshot = { ...prior, schemaVersion: prior.schemaVersion === 3 ? 3 : 2, records: [...prior.records, entry] };
    const rollover = next.records.length > MAX_WORKING_SET_RECORDS || Buffer.byteLength(JSON.stringify(next)) > MAX_WORKING_SET_BYTES;
    if (rollover) fail("requires_async");
    this.assertAvailable(); guard();
    if (this.snapshot !== prior) fail("record_conflict");
    try {
      this.assertAvailable(); this.verifyHistory(); guard();
      if (this.snapshot !== prior) fail("record_conflict");
      this.storage.commit(next); this.snapshot = next;
    } catch (error: unknown) {
      if (error instanceof PrivateWorkingSetError) throw error;
      if (error instanceof OwnedJsonSnapshotError && error.code === "snapshot_too_large") fail("journal_full");
      fail("state_unavailable");
    }
    return frozen({ ...structuredClone(entry), sequence });
  }

  private async appendRecordAsync(entry: StoredRecord, operation: WorkingSetOperation): Promise<Readonly<StoredRecord & { sequence: number }>> {
    const prior = this.snapshot; const found: { replay?: HistoryRow } = {};
    await this.scanAsync((row) => {
      if (key(row.entry) !== key(entry)) return;
      if (found.replay) { this.held = true; fail("state_unavailable"); } found.replay = row;
    }, prior, operation);
    await this.pause(prior, operation);
    const replay = found.replay;
    if (replay) {
      if (replay.entry.kind !== entry.kind || storedDigest(replay.entry) !== storedDigest(entry)) fail("record_conflict");
      const result = frozen({ ...structuredClone(replay.entry), sequence: replay.sequence }); this.fence(prior, operation); return result;
    }
    const sequence = (prior.archiveHead?.endSequence ?? 0) + prior.records.length + 1;
    if (!Number.isSafeInteger(sequence)) fail("journal_full");
    let next: Snapshot = { ...prior, schemaVersion: prior.schemaVersion === 3 ? 3 : 2, records: [...prior.records, entry] };
    const rollover = next.records.length > MAX_WORKING_SET_RECORDS || Buffer.byteLength(JSON.stringify(next)) > MAX_WORKING_SET_BYTES;
    this.fence(prior, operation);
    try {
      if (rollover) {
        if (!prior.records.length) fail("journal_full");
        const archiveHead = this.archive.preserve(prior.records, prior.archiveHead ?? null);
        next = { schemaVersion: 3, localProfileId: prior.localProfileId, records: [entry], archiveHead };
      }
      // No await after this final abort/generation/owner/identity fence.
      this.fence(prior, operation); this.storage.commit(next); this.snapshot = next;
    } catch (error: unknown) {
      if (error instanceof PrivateWorkingSetError) throw error;
      if (error instanceof OwnedJsonSnapshotError && error.code === "snapshot_too_large") fail("journal_full");
      fail("state_unavailable");
    }
    return frozen({ ...structuredClone(entry), sequence });
  }
  private prepareRead(input: QueryScope, nowMs: number, options: WorkingSetReadOptions) {
    const scope = this.scope(input); if (!Number.isFinite(nowMs)) fail("invalid_request"); this.assertAvailable();
    exact(options, [], ["focusRefIds"]);
    if (options.focusRefIds !== undefined && (!Array.isArray(options.focusRefIds) || options.focusRefIds.length > MAX_WORKING_FOCUS_REFS)) fail("invalid_request");
    const refs = new Set((options.focusRefIds ?? []).map((ref) => { if (typeof ref !== "string") fail("invalid_request"); return parseRef(ref).refId; }));
    const matches = (entry: StoredRecord) => storedScope(entry).localAgentId === scope.localAgentId && storedScope(entry).conversationId === scope.conversationId;
    const lists = new Map<RunnerResearchChain, WorkingSetList>();
    const recent: WorkingSetRecord[] = []; let totalRecords = 0; let archivedRecords = 0;
    const pinned = new Map<number, WorkingSetRecord>(); const exactSeen = new Set<string>();
    return { first: (row: HistoryRow): void => {
      if (!matches(row.entry)) return;
      totalRecords++; if (row.archived) archivedRecords++;
      const request = storedRequest(row.entry);
      if (recent.length < MAX_WORKING_SET_RECORDS || request.kind === "market_brief" && !lists.get(request.chain)?.context) {
        const item = record(row.entry, row.sequence, nowMs);
        if (recent.length < MAX_WORKING_SET_RECORDS) recent.push(item);
        if (request.kind === "market_brief") {
          const current = lists.get(request.chain);
          if (!current) lists.set(request.chain, { chain: request.chain, latestAttempt: item, ...(item.evidence.kind === "report" ? { context: item } : {}) });
          else if (!current.context && item.evidence.kind === "report") lists.set(request.chain, { ...current, context: item });
        }
      }
    }, prepareExact: (): void => {
      for (const list of lists.values()) for (const row of discoveryRows(list)) refs.add(row.asset.refId);
      // At most 4 list records + 2*(24 active assets + 24 focused assets) = 100 pins.

      for (const list of lists.values()) { pinned.set(list.latestAttempt.sequence, list.latestAttempt); if (list.context) pinned.set(list.context.sequence, list.context); }

    }, second: (row: HistoryRow): void => {
      if (!matches(row.entry)) return;
      const request = storedRequest(row.entry); if (request.kind === "market_brief") return;
      const ref = assetRef(request.chain, request.assetId).refId; const target = `${request.kind}:${ref}`;
      if (refs.has(ref) && !exactSeen.has(target)) { exactSeen.add(target); pinned.set(row.sequence, record(row.entry, row.sequence, nowMs)); }
    }, finish: (): WorkingSetView => {
      if (pinned.size > MAX_WORKING_SET_RECORDS) fail("invalid_evidence");
      for (const item of recent) { if (pinned.size >= MAX_WORKING_SET_RECORDS) break; pinned.set(item.sequence, item); }
      const records = [...pinned.values()].sort((a, b) => a.sequence - b.sequence);
      return frozen({ scope, records, activeLists: [...lists.values()].sort((a, b) => a.chain.localeCompare(b.chain)),
        retention: { totalRecords, archivedRecords, omittedRecords: totalRecords - records.length }, executionAuthority: authority });
    } };
  }
  read(input: QueryScope, nowMs: number, options: WorkingSetReadOptions = {}): WorkingSetView {
    this.assertSynchronous(); const prior = this.snapshot; const work = this.prepareRead(input, nowMs, options);
    for (const row of this.historyNewest()) work.first(row); work.prepareExact();
    for (const row of this.historyNewest()) work.second(row);
    const result = work.finish(); this.fence(prior, {}); return result;
  }
  async readAsync(input: QueryScope, nowMs: number, options: WorkingSetReadOptions = {}, operation: WorkingSetOperation = {}): Promise<WorkingSetView> {
    operation = { ...operation };
    const prior = this.snapshot; const work = this.prepareRead(input, nowMs, options);
    await this.scanAsync(work.first, prior, operation); work.prepareExact();
    await this.scanAsync(work.second, prior, operation);
    const result = work.finish(); this.fence(prior, operation); return result;
  }

  private prepareHistory(input: QueryScope, nowMs: number, options: { beforeSequence?: number; limit?: number }) {
    const scope = this.scope(input); this.assertAvailable(); exact(options, [], ["beforeSequence", "limit"]);
    const limit = options.limit ?? MAX_WORKING_SET_RECORDS; const beforeSequence = options.beforeSequence;
    if (!Number.isFinite(nowMs) || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_WORKING_SET_RECORDS
      || beforeSequence !== undefined && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) fail("invalid_request");
    const records: WorkingSetRecord[] = []; let more = false;
    return { visit: (row: HistoryRow): void => {
      if (storedScope(row.entry).localAgentId !== scope.localAgentId || storedScope(row.entry).conversationId !== scope.conversationId
        || beforeSequence !== undefined && row.sequence >= beforeSequence) return;
      if (records.length < limit) records.push(record(row.entry, row.sequence, nowMs)); else more = true;
    }, finish: (): WorkingSetHistoryPage => {
      return frozen({ scope, records: records.reverse(), beforeSequence: beforeSequence ?? null,
        nextBeforeSequence: more ? records[0]!.sequence : null, executionAuthority: authority });
    } };
  }
  readHistory(input: QueryScope, nowMs: number, options: { beforeSequence?: number; limit?: number } = {}): WorkingSetHistoryPage {
    this.assertSynchronous(); const prior = this.snapshot; const work = this.prepareHistory(input, nowMs, options);
    for (const row of this.historyNewest()) work.visit(row);
    const result = work.finish(); this.fence(prior, {}); return result;
  }
  async readHistoryAsync(input: QueryScope, nowMs: number, options: { beforeSequence?: number; limit?: number } = {}, operation: WorkingSetOperation = {}): Promise<WorkingSetHistoryPage> {
    operation = { ...operation };
    const prior = this.snapshot; const work = this.prepareHistory(input, nowMs, options);
    await this.scanAsync(work.visit, prior, operation);
    const result = work.finish(); this.fence(prior, operation); return result;
  }

  select(scope: QueryScope, selector: WorkingSetSelector, nowMs: number): WorkingSetSelection {
    selector = parseWorkingSetSelector(selector);
    const view = this.read(scope, nowMs, selector.kind === "refId" ? { focusRefIds: [selector.refId] } : {});
    return this.selectView(view, selector);
  }
  async selectAsync(scope: QueryScope, selector: WorkingSetSelector, nowMs: number, operation: WorkingSetOperation = {}): Promise<WorkingSetSelection> {
    operation = { ...operation };
    selector = parseWorkingSetSelector(selector); const prior = this.snapshot;
    const view = await this.readAsync(scope, nowMs, selector.kind === "refId" ? { focusRefIds: [selector.refId] } : {}, operation);
    const result = this.selectView(view, selector); this.fence(prior, operation); return result;
  }
  private selectView(view: WorkingSetView, selector: WorkingSetSelector): WorkingSetSelection {
    const unresolved = (reason: Extract<WorkingSetSelection, { kind: "unresolved" }> ["reason"], options: ResearchAssetRef[] = []): WorkingSetSelection =>
      frozen({ kind: "unresolved", reason, options, executionAuthority: authority });
    const resolved = (assets: WorkingSetAsset[]): WorkingSetSelection => {
      if (assets.some((item) => [item.candidateReport, item.riskReport].some((evidence) => evidence
        && (evidence.evidence.kind !== "report" || evidence.assessment?.state === "hold")))) return unresolved("held", assets.map((item) => item.asset));
      return frozen({ kind: "resolved", assets, executionAuthority: authority });
    };
    if (selector.kind === "refId") {
      const ref = parseRef(selector.refId); const asset = this.asset(view, ref);
      // An explicit exact-asset report has its own observations and does not need a discovery list.
      if (asset.candidateReport || asset.riskReport) return resolved([asset]);
      const list = view.activeLists.find((item) => item.chain === ref.chain);
      if (!asset.discovery || !list) return unresolved("not_found");
      if (list.latestAttempt.evidence.kind !== "report" || list.latestAttempt.assessment?.state === "hold") return unresolved("held", [ref]);
      return resolved([asset]);
    }
    const lists = view.activeLists.filter((list) => !selector.chain || list.chain === selector.chain);
    if (!lists.length) return unresolved("no_active_list");
    if (lists.length > 1) return unresolved("chain_ambiguous", lists.flatMap((list) => discoveryRows(list).map((row) => row.asset)));
    const list = lists[0]!; const rows = discoveryRows(list);
    if (list.latestAttempt.evidence.kind !== "report" || list.latestAttempt.assessment?.state === "hold") return unresolved("held", rows.map((row) => row.asset));
    let selected: readonly DiscoveryObservation[] = rows;
    if (selector.kind === "ordinal") {
      if (selector.ordinal > rows.length) return unresolved("ordinal_out_of_range", rows.map((row) => row.asset));
      selected = [rows[selector.ordinal - 1]!];
    } else if (selector.kind === "symbol") {
      selected = rows.filter((row) => row.symbol?.toLocaleLowerCase("en-US") === selector.symbol.toLocaleLowerCase("en-US"));
      if (!selected.length) return unresolved("not_found");
      if (selected.length > 1) return unresolved("symbol_ambiguous", selected.map((row) => row.asset));
    } else if (selector.kind === "lowest") {
      if (!rows.length) return unresolved("not_found");
      if (rows.some((row) => row[selector.metric] === undefined)) return unresolved("metric_missing", rows.map((row) => row.asset));
      const minimum = Math.min(...rows.map((row) => row[selector.metric]!));
      selected = rows.filter((row) => row[selector.metric] === minimum);
      if (selected.length > 1) return unresolved("tie", selected.map((row) => row.asset));
    }
    return resolved(selected.map((row) => this.asset(view, row.asset)));
  }

  close(): void { this.storage.close(); }
  private assertAvailable(): void { try { if (this.held) fail("state_unavailable"); this.storage.assertAvailable(); } catch { fail("state_unavailable"); } }
  private scope(value: QueryScope): ResearchScope {
    exact(value, ["localAgentId", "conversationId"]);
    if (!isId(value.localAgentId) || !isId(value.conversationId)) fail("invalid_request");
    if (!this.options.agentIds.includes(value.localAgentId)) fail("scope_mismatch");
    return { localProfileId: this.options.localProfileId, localAgentId: value.localAgentId, conversationId: value.conversationId };
  }
  private asset(view: WorkingSetView, ref: ResearchAssetRef): WorkingSetAsset {
    let candidateReport: WorkingSetRecord | undefined; let riskReport: WorkingSetRecord | undefined;
    for (const item of view.records) {
      const request = workingSetRecordRequest(item);
      if (request.kind === "market_brief" || assetRef(request.chain, request.assetId).refId !== ref.refId) continue;
      if (request.kind === "candidate_report") candidateReport = item; else riskReport = item;
    }
    const list = view.activeLists.find((item) => item.chain === ref.chain); const rows = list ? discoveryRows(list) : [];
    const ordinal = rows.findIndex((row) => row.asset.refId === ref.refId);
    return { asset: ref, ...(ordinal < 0 ? {} : { discovery: { sequence: list!.context!.sequence, ordinal: ordinal + 1, observation: rows[ordinal]!,
      assessment: list!.context!.assessment!, contextOnly: list!.context!.assessment!.state === "hold"
        || list!.latestAttempt.evidence.kind !== "report" || list!.latestAttempt.assessment?.state === "hold" } }),
      ...(candidateReport ? { candidateReport } : {}), ...(riskReport ? { riskReport } : {}) };
  }
  private decode(value: unknown): Snapshot {
    exact(value, ["schemaVersion", "localProfileId", "records"], ["archiveHead"]);
    if (value.schemaVersion === 3) exact(value, ["schemaVersion", "localProfileId", "records", "archiveHead"]);
    else if (Object.hasOwn(value, "archiveHead")) fail("state_unavailable");
    const archiveHead = value.schemaVersion === 3 ? workingArchiveHead(value.archiveHead) : null;
    if (value.schemaVersion === 3 && !archiveHead) fail("state_unavailable");
    if ((value.schemaVersion !== 1 && value.schemaVersion !== 2 && value.schemaVersion !== 3) || value.localProfileId !== this.options.localProfileId
      || !Array.isArray(value.records) || value.records.length > MAX_WORKING_SET_RECORDS) fail("state_unavailable");
    const keys = new Set<string>();
    const records = value.records.map((row: unknown): StoredRecord => {
      if (value.schemaVersion !== 1) {
        exact(row, ["kind", "jobId", "requestId"], ["snapshot", "marker"]);
        if (row.kind === "local_failure") {
          exact(row, ["kind", "jobId", "requestId", "marker"]); exact(row.marker, ["version", "scope", "jobId", "requestId", "request", "failedAt", "reason", "failureDigest"]);
          exact(row.marker.scope, ["localProfileId", "localAgentId", "conversationId"]);
          const marker = failureMarker(row.marker, this.scope({ localAgentId: String(row.marker.scope.localAgentId), conversationId: String(row.marker.scope.conversationId) }));
          if (row.jobId !== marker.jobId || row.requestId !== marker.requestId) fail("state_unavailable");
          const entry: StoredFailure = { kind: "local_failure", jobId: marker.jobId, requestId: marker.requestId, marker };
          const id = key(entry); if (keys.has(id)) fail("state_unavailable"); keys.add(id); return entry;
        }
        if (row.kind !== "receipt") fail("state_unavailable"); exact(row, ["kind", "jobId", "requestId", "snapshot"]);
      } else exact(row, ["jobId", "requestId", "snapshot"]);
      if (!isId(row.jobId) || !isId(row.requestId)) fail("state_unavailable");
      exact(row.snapshot, ["version", "scope", "receipt", "snapshotDigest"]);
      exact(row.snapshot.scope, ["localProfileId", "localAgentId", "conversationId"]);
      const s = row.snapshot.scope;
      if (s.localProfileId !== this.options.localProfileId || typeof s.localAgentId !== "string" || typeof s.conversationId !== "string") fail("state_unavailable");
      const evidence = loadSnapshot(JSON.stringify(row.snapshot), this.scope({ localAgentId: s.localAgentId, conversationId: s.conversationId }));
      const entry: StoredReceipt = { kind: "receipt", jobId: row.jobId, requestId: row.requestId, snapshot: evidence.snapshot }; const id = key(entry);
      if (keys.has(id)) fail("state_unavailable"); keys.add(id); return entry;
    });
    if (!Number.isSafeInteger((archiveHead?.endSequence ?? 0) + records.length)) fail("state_unavailable");
    return { schemaVersion: value.schemaVersion, localProfileId: this.options.localProfileId, records, ...(value.schemaVersion === 3 ? { archiveHead } : {}) };
  }
}
function discoveryRows(list: WorkingSetList): readonly DiscoveryObservation[] {
  const evidence = list.context?.evidence;
  return evidence?.kind === "report" && evidence.report.kind === "market_brief" ? evidence.report.candidates : [];
}
function parseRef(ref: string): ResearchAssetRef {
  const match = /^asset:(solana|base):(.+)$/.exec(ref);
  if (!match) fail("invalid_request");
  let value: ResearchAssetRef;
  try { value = assetRef(match[1] as RunnerResearchChain, match[2]!); } catch { fail("invalid_request"); }
  if (value.refId !== ref) fail("invalid_request"); return value;
}
function validateSelector(value: WorkingSetSelector): void {
  const fields = value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "kind")?.value : undefined;
  if (!["all", "ordinal", "symbol", "lowest", "refId"].includes(fields)) fail("invalid_request");
  exact(value, ["kind", ...(fields === "ordinal" ? ["ordinal"] : fields === "symbol" ? ["symbol"] : fields === "lowest" ? ["metric"] : fields === "refId" ? ["refId"] : [])], fields === "refId" ? [] : ["chain"]);
  if (value.kind !== "refId" && value.chain !== undefined && value.chain !== "solana" && value.chain !== "base") fail("invalid_request");
  if (value.kind === "refId") { if (typeof value.refId !== "string") fail("invalid_request"); parseRef(value.refId); }
  if (value.kind === "ordinal" && (!Number.isSafeInteger(value.ordinal) || value.ordinal < 1)) fail("invalid_request");
  if (value.kind === "symbol" && (typeof value.symbol !== "string" || value.symbol.length < 1 || value.symbol.length > 128 || value.symbol.trim() !== value.symbol)) fail("invalid_request");
  if (value.kind === "lowest" && value.metric !== "liquidityUsd" && value.metric !== "marketCapUsd") fail("invalid_request");
}

/** Closed local model-output intent. It accepts identifiers, never prose or authority. */
export function parseWorkingSetSelector(value: unknown): WorkingSetSelector {
  validateSelector(value as WorkingSetSelector);
  return frozen(structuredClone(value as WorkingSetSelector));
}
