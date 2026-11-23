/** S8b autonomous execution queue. Completed signal jobs stay immutable; their execution outcome lives in this separate
 * per-agent fsynced store, one intent per signal job id (idempotent across duplicate signals, re-delivery and restarts).
 *
 * Admission (privateExecutionAdmission): only a completed `buy` decision gets an intent. It is `queued` when its plan is
 * resolved (amount + slippage within the 5000 bps assessment bound), its confirmed rules carry no owner approval
 * requirement and its saved assessment is complete with pre-trade verdict `allow`; otherwise it is recorded `not_executed`
 * with the closed reason and is never queued. Hold/skip/sell decisions get no intent.
 *
 * Worker (PrivateExecutionWorker): one drain per agent (an agent has exactly one trading wallet, so this serializes per
 * wallet), oldest queued intent first. Each step re-reads authority and records exactly one outcome, never retried:
 * - `expired` (expired_intent:*): signal older than 300 s, or any admitted evidence past its staleAt;
 * - `refused`: a choke-point refusal (private-execution-gate.ts `entry_build`: not live_armed, entries paused, runtime
 *   changed, approval), an S5c exit hold (`exit_hold:<reason>`, only while exits are available), limits missing,
 *   RPC unset/public, wallet held (unfinished attempt, open reservation or
 *   unacknowledged copy), the owner's max positions at a time, only when the owner's rules state one (max_positions: a buy of a mint
 *   not already held while that many mints are held or being bought; max_positions_unknown when the count or whether a limit is stated
 *   cannot be read), keystore absent/held, keystore still locked after the bounded wait (keystore_locked), the
 *   per-wallet rate guard (one new buy per 30 s: rate_limited), a build refusal (`build:<stage>:<code>`) or a submission
 *   refusal before any signature (`submit:<code>`);
 * - `running` is durable before the build starts, and only one intent per agent is ever `running` (a second start is
 *   refused intent_running, and the store refuses a second `running` without poisoning itself). A daemon that dies there
 *   leaves it `running`; recovery resolves it from the journal only: an attempt for its reservation -> `submitted`, else
 *   `refused` interrupted (S4 start recovery has already released a never-signed reservation). It is never built again.
 *   Recovery runs at worker start and, when that failed (held store), again before the agent's next drain;
 * - the signal age / evidence staleness cutoff is re-checked by the submission immediately before the one signature, not
 *   only when the intent starts: past it, nothing is signed, the reservation is released and the intent is `refused`
 *   submit:expired_intent:*;
 * - `submitted`: signed and journaled (S4 owns relay, resends and settlement; readback joins the journal state);
 * - `held`: an ambiguous build exchange (reservation retained) or a signed attempt whose journal write failed.
 * A locked keystore while armed keeps the intent queued (waitingSince, reason waiting:keystore_locked, shown in status),
 * re-checked every poll, bounded by PRIVATE_EXECUTION_KEYSTORE_WAIT_MS and the stale cutoff.
 * M3.6: the build also waits (queued, in memory, bounded by PRIVATE_EXECUTION_SYNC_WAIT_MS and the stale cutoff) until
 * Balchemy has accepted the current armed runtime state (its arming gate reads that mirror) and has answered this signal's
 * ACK (its provenance check needs the ACK's receivedAt); past the bound the intent is `refused` arm_unconfirmed or
 * signal_ack_unconfirmed, still before any reservation or network call. Grants no authority itself:
 * build, sign and relay each pass their own gates (and the backend's arming gate).
 *
 * A completion whose admission was lost (a crash between completing the job and admitting it) is not re-admitted: no
 * agent is armed after a restart (state.ts never restores live_armed), so the decision simply never executes. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp, type RunnerAgentState } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { privateApprovalRequired, privateExecutionGate, type PrivateExecutionCapabilities, type PrivateExecutionGatePlan, type PrivateExecutionLiveFacts } from "./private-execution-gate.js";
import type { PrivateSpendStatus } from "./private-spend-ledger.js";
import type { PrivateExecutionBuildOutcome } from "./private-execution-build.js";
import type { PrivateSubmissionOutcome, PrivateValidatedExecution } from "./private-submission.js";
import { PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS, type PrivateSignalJob } from "./private-signal-job.js";
import type { PrivateSignalPlan } from "./private-signal-plan.js";
import type { PrivateSpendLedger } from "./private-spend-ledger.js";
import { privateRpcClassExecutable, type PrivateEffectiveRpcStatus } from "./private-solana-rpc-settings.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import { isPrivateSubmissionTerminal, privateSubmissionCopyHeld, PRIVATE_SUBMISSION_STATES, type PrivateSubmissionAttempt,
  type PrivateSubmissionState } from "./private-submission-journal.js";
import { addRunnerAgent } from "./agent-roster.js";
import { privateMaxPositionsRefusal, type PrivateMaxPositions } from "./private-typed-rules.js";

export const PRIVATE_EXECUTION_INTENT_STATES = ["queued", "running", "submitted", "refused", "not_executed", "expired", "held"] as const;
export type PrivateExecutionIntentState = typeof PRIVATE_EXECUTION_INTENT_STATES[number];
/** Same bound as the signal decision's own freshness window. */
export const PRIVATE_EXECUTION_SIGNAL_MAX_AGE_MS = 300_000;
export const PRIVATE_EXECUTION_RATE_MS = 30_000;
export const PRIVATE_EXECUTION_KEYSTORE_WAIT_MS = 60_000;
export const PRIVATE_EXECUTION_POLL_MS = 2_000;
/** M3.6: bound on waiting for Balchemy to mirror the armed state and to answer the signal's ACK (several heartbeat/poll cycles). */
export const PRIVATE_EXECUTION_SYNC_WAIT_MS = 30_000;
const MAX_INTENTS = 256;
const MAX_BYTES = 192 * 1024;
const JOB = /^signal_[0-9a-f]{64}$/;
const REASON = /^[a-z0-9_:]{1,96}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ATTEMPT = /^att:[0-9a-f]{32}$/;

export interface PrivateExecutionIntent {
  jobId: string; state: PrivateExecutionIntentState; reason: string | null;
  /** Signal observation time and plan digest, copied at admission. */
  observedAt: number; planDigest: string | null;
  walletAddress: string | null; attemptKey: string | null;
  createdAt: number; updatedAt: number; startedAt: number | null; waitingSince: number | null;
}
export type PrivateExecutionIntentChange = Partial<Pick<PrivateExecutionIntent, "state" | "reason" | "walletAddress" | "attemptKey" | "startedAt" | "waitingSince">>;
/** Readback projection: the intent outcome plus the joined journal state of its attempt (null without one). */
export interface PrivateExecutionOutcomeView {
  state: PrivateExecutionIntentState; reason: string | null; attemptKey: string | null; trade: PrivateSubmissionState | null; updatedAt: number;
}
export interface PrivateExecutionQueueStatus {
  queued: number; running: number; waiting: "keystore_locked" | null;
  last: { jobId: string; state: PrivateExecutionIntentState; reason: string | null; updatedAt: number } | null;
}
export const PRIVATE_EXECUTION_INTENT_ERRORS = ["invalid_request", "unknown_agent", "intent_conflict", "capacity_exhausted", "clock_rollback",
  "state_unavailable", "closing"] as const;
export class PrivateExecutionIntentError extends Error {
  constructor(readonly code: typeof PRIVATE_EXECUTION_INTENT_ERRORS[number]) { super(`Execution intents ${code}`); this.name = "PrivateExecutionIntentError"; }
}
function fail(code: PrivateExecutionIntentError["code"] = "invalid_request"): never { throw new PrivateExecutionIntentError(code); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
const nullable = (value: unknown, check: (item: unknown) => boolean): boolean => value === null || check(value);
const stamp = (value: unknown): boolean => isTimestamp(value);
const terminal = (state: PrivateExecutionIntentState): boolean => state !== "queued" && state !== "running";

function parseIntent(value: unknown): PrivateExecutionIntent {
  exact(value, ["jobId", "state", "reason", "observedAt", "planDigest", "walletAddress", "attemptKey", "createdAt", "updatedAt", "startedAt", "waitingSince"]);
  const v = value;
  if (typeof v.jobId !== "string" || !JOB.test(v.jobId) || !PRIVATE_EXECUTION_INTENT_STATES.includes(v.state as PrivateExecutionIntentState)
    || !nullable(v.reason, (item) => typeof item === "string" && REASON.test(item)) || !isTimestamp(v.observedAt)
    || !nullable(v.planDigest, (item) => typeof item === "string" && DIGEST.test(item)) || !nullable(v.walletAddress, isSolanaAddress)
    || !nullable(v.attemptKey, (item) => typeof item === "string" && ATTEMPT.test(item)) || !isTimestamp(v.createdAt) || !isTimestamp(v.updatedAt)
    || v.updatedAt < v.createdAt || !nullable(v.startedAt, stamp) || !nullable(v.waitingSince, stamp)) fail();
  const state = v.state as PrivateExecutionIntentState;
  // Shape invariants: nothing started before `running`; an attempt key only once submitted; waiting only while queued;
  // every non-success terminal state names its reason.
  const started = v.startedAt !== null && v.walletAddress !== null, attempt = v.attemptKey !== null, idle = v.waitingSince === null;
  const ok = state === "queued" ? v.startedAt === null && !attempt
    : state === "running" ? started && !attempt && idle && v.reason === null
      : state === "submitted" ? started && attempt && idle
        : state === "held" ? started && !attempt && idle && v.reason !== null
          : state === "refused" ? !attempt && idle && v.reason !== null
            : v.startedAt === null && !attempt && idle && v.reason !== null;
  if (!ok) fail();
  return { jobId: v.jobId, state, reason: v.reason as string | null, observedAt: v.observedAt, planDigest: v.planDigest as string | null,
    walletAddress: v.walletAddress as string | null, attemptKey: v.attemptKey as string | null, createdAt: v.createdAt, updatedAt: v.updatedAt,
    startedAt: v.startedAt as number | null, waitingSince: v.waitingSince as number | null };
}
interface Snapshot { schemaVersion: 1; localProfileId: string; agentId: string; lastObservedAt: number; intents: PrivateExecutionIntent[] }
function parseSnapshot(value: unknown, scope: { localProfileId: string; agentId: string }): Snapshot {
  exact(value, ["schemaVersion", "localProfileId", "agentId", "lastObservedAt", "intents"]);
  if (value.schemaVersion !== 1 || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId || !isTimestamp(value.lastObservedAt)
    || !Array.isArray(value.intents) || value.intents.length > MAX_INTENTS) fail();
  const intents = (value.intents as unknown[]).map(parseIntent);
  if (new Set(intents.map((item) => item.jobId)).size !== intents.length || intents.some((item) => item.updatedAt > (value.lastObservedAt as number))
    || intents.filter((item) => item.state === "running").length > 1) fail();
  return { schemaVersion: 1, ...scope, lastObservedAt: value.lastObservedAt, intents };
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function privateExecutionIntentFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `execution-intents-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
/** Closed readback parser shared by the signal channel. */
export function parsePrivateExecutionOutcomeView(value: unknown): PrivateExecutionOutcomeView {
  exact(value, ["state", "reason", "attemptKey", "trade", "updatedAt"]);
  if (!PRIVATE_EXECUTION_INTENT_STATES.includes(value.state as PrivateExecutionIntentState) || !nullable(value.reason, (item) => typeof item === "string" && REASON.test(item))
    || !nullable(value.attemptKey, (item) => typeof item === "string" && ATTEMPT.test(item))
    || !nullable(value.trade, (item) => PRIVATE_SUBMISSION_STATES.includes(item as PrivateSubmissionState)) || !isTimestamp(value.updatedAt)
    || (value.trade !== null && value.attemptKey === null)) fail();
  return { state: value.state as PrivateExecutionIntentState, reason: value.reason as string | null, attemptKey: value.attemptKey as string | null,
    trade: value.trade as PrivateSubmissionState | null, updatedAt: value.updatedAt };
}

export interface PrivateExecutionIntentsOptions {
  directory: string; localProfileId: string; agentIds: readonly string[]; assertAvailable(): void;
  /** Final audit S3: the guard of one admission at capacity, read once per admission: terminal intents the caller still needs (an intent
   * whose completed buy has not opened its position yet: it is the only provenance of that position's plan and exit rules) are never
   * evicted while it returns true. A throw (of the factory or the guard) retains. Omitted: eviction is unchanged (the oldest terminal
   * intent makes room). */
  retain?(agentId: string): (intent: PrivateExecutionIntent) => boolean;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<Snapshot> };

/** The durable store. Same writer discipline as the spend ledger: one synchronous read-check-commit per change. */
export class PrivateExecutionIntents {
  readonly #options: PrivateExecutionIntentsOptions;
  readonly #agentIds: string[];
  readonly #slots = new Map<string, Slot>();
  #closed = false;
  constructor(options: PrivateExecutionIntentsOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.assertAvailable !== "function"
      || (options.retain !== undefined && typeof options.retain !== "function")) fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, directory: path.resolve(options.directory), agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  /** Read-only; an agent without intents creates no file. */
  list(agentId: string): readonly PrivateExecutionIntent[] { return freeze((this.#read(agentId, false)?.intents ?? []).map((item) => ({ ...item }))); }
  get(agentId: string, jobId: string): PrivateExecutionIntent | undefined { return this.list(agentId).find((item) => item.jobId === jobId); }
  /** Idempotent by jobId: an existing intent (any state) is returned unchanged. Old terminal intents make room, except those the
   * caller's `retain` keeps (S3); with none left the admission refuses capacity_exhausted (nothing executes: fail closed). */
  admit(agentId: string, input: Pick<PrivateExecutionIntent, "jobId" | "state" | "reason" | "observedAt" | "planDigest">, nowMs: number): { intent: PrivateExecutionIntent; created: boolean } {
    if (input.state !== "queued" && input.state !== "not_executed") fail();
    return this.#mutate(agentId, nowMs, false, (snapshot): { next: Snapshot | undefined; result: { intent: PrivateExecutionIntent; created: boolean } } => {
      const existing = snapshot.intents.find((item) => item.jobId === input.jobId);
      if (existing) return { next: undefined, result: { intent: { ...existing }, created: false } };
      const intent = parseIntent({ jobId: input.jobId, state: input.state, reason: input.reason, observedAt: input.observedAt, planDigest: input.planDigest,
        walletAddress: null, attemptKey: null, createdAt: nowMs, updatedAt: nowMs, startedAt: null, waitingSince: null });
      let intents = [...snapshot.intents];
      if (intents.length >= MAX_INTENTS) {
        let guard: ((intent: PrivateExecutionIntent) => boolean) | "all" | undefined;
        try { guard = this.#options.retain?.(agentId); } catch { guard = "all"; }
        const kept = (item: PrivateExecutionIntent): boolean => {
          if (guard === undefined) return false;
          if (guard === "all") return true;
          try { return guard({ ...item }) !== false; } catch { return true; }
        };
        const oldest = intents.filter((item) => terminal(item.state) && !kept(item)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (!oldest) fail("capacity_exhausted");
        intents = intents.filter((item) => item !== oldest);
      }
      return { next: { ...snapshot, intents: [...intents, intent] }, result: { intent: { ...intent }, created: true } };
    });
  }
  /** Compare-and-set on the current state; a terminal intent never changes again. The outcome of an intent already `running`
   * (expected "running") is recorded even while the wall clock is behind the store's mark, its time clamped to the mark: a step
   * back during a build or submit must not leave the intent running (every sell of the wallet waits on it, F-FINAL-H1). Every
   * other change, a new start included, still refuses clock_rollback. */
  update(agentId: string, jobId: string, expected: PrivateExecutionIntentState, change: PrivateExecutionIntentChange, nowMs: number): PrivateExecutionIntent {
    return this.#mutate(agentId, nowMs, expected === "running", (snapshot, at) => {
      const index = snapshot.intents.findIndex((item) => item.jobId === jobId);
      const existing = snapshot.intents[index];
      if (!existing || existing.state !== expected || terminal(existing.state)) fail("intent_conflict");
      if (change.state === "running" && snapshot.intents.some((item) => item.state === "running" && item.jobId !== jobId)) fail("intent_conflict");
      const next = parseIntent({ ...existing, ...change, updatedAt: at });
      const intents = [...snapshot.intents]; intents[index] = next;
      return { next: { ...snapshot, intents }, result: { ...next } };
    });
  }
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Preserve files. */ } }
    this.#slots.clear();
  }
  /** One read-check-commit at `at`: nowMs, or, when `clampToMark` and the wall clock is below lastObservedAt, lastObservedAt itself. */
  #mutate<T>(agentId: string, nowMs: number, clampToMark: boolean, change: (snapshot: Snapshot, at: number) => { next: Snapshot | undefined; result: T }): T {
    if (!isTimestamp(nowMs)) fail();
    const slot = this.#slot(agentId, true);
    if (!slot || slot.kind !== "open") return fail("state_unavailable");
    let snapshot: Snapshot;
    try { snapshot = slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    let at = nowMs;
    if (nowMs < snapshot.lastObservedAt) {
      if (!clampToMark) fail("clock_rollback");
      at = snapshot.lastObservedAt;
    }
    const { next, result } = change(snapshot, at);
    if (next) {
      try { slot.storage.commit(parseSnapshot(structuredClone({ ...next, lastObservedAt: at }), { localProfileId: this.#options.localProfileId, agentId })); }
      catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    }
    return freeze(result);
  }
  #read(agentId: string, create: boolean): Snapshot | undefined {
    const slot = this.#slot(agentId, create);
    if (!slot) return undefined;
    if (slot.kind === "held") return fail("state_unavailable");
    try { return slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
  }
  #slot(agentId: string, create: boolean): Slot | undefined {
    if (this.#closed) fail("closing");
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent");
    try { this.#options.assertAvailable(); } catch { return fail("state_unavailable"); }
    const current = this.#slots.get(agentId);
    if (current) return current;
    const files = privateExecutionIntentFiles(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#options.directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { if (!create && !exists(files.markerFile) && !exists(files.snapshotFile)) return undefined; }
    catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
    try {
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      const storage = new OwnedJsonSnapshot<Snapshot>({ directory: this.#options.directory, ...files,
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId, kind: "execution_intents" }, maximumBytes: MAX_BYTES,
        initial: { schemaVersion: 1, ...scope, lastObservedAt: 0, intents: [] }, assertAvailable: this.#options.assertAvailable,
        decode: (value) => parseSnapshot(value, scope) });
      const slot: Slot = { kind: "open", storage }; this.#slots.set(agentId, slot); return slot;
    } catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
  }
}

/** Null for a decision that never executes (not a completed buy); otherwise queued or not_executed with its closed reason. */
export function privateExecutionAdmission(job: PrivateSignalJob): { state: "queued" | "not_executed"; reason: string | null } | null {
  const result = job.result;
  if (job.state !== "completed" || !result || result.decision.action !== "buy") return null;
  const plan = result.plan; const assessment = result.assessment;
  const not = (reason: string) => ({ state: "not_executed" as const, reason });
  if (!plan || plan.state !== "resolved" || !plan.amount || plan.slippageBps === null || plan.asset.chain !== "solana") return not("plan_not_resolved");
  if (plan.slippageBps > PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS) return not("slippage_above_bound");
  if (!plan.risks || !plan.exit) return not("rules_unavailable");
  if (privateApprovalRequired(plan.risks)) return not("owner_approval_required");
  if (!assessment || assessment.outcome !== "complete" || !assessment.pretrade) return not("assessment_incomplete");
  if (assessment.pretrade.verdict === "block") return not("pretrade_blocked");
  if (assessment.pretrade.verdict !== "allow") return not("pretrade_requires_approval");
  return { state: "queued", reason: null };
}
/** The stale-intent cutoff, applied at every attempt to start. */
export function privateExecutionExpiry(job: PrivateSignalJob, nowMs: number): string | null {
  const observed = Date.parse(job.receipt.signal.observedAt);
  if (!Number.isFinite(observed) || nowMs - observed >= PRIVATE_EXECUTION_SIGNAL_MAX_AGE_MS || nowMs < observed) return "expired_intent:signal_age";
  const evidence = job.result?.plan?.evidence ?? [];
  if (evidence.length === 0 || evidence.some((item) => !(nowMs < Date.parse(item.staleAt)))) return "expired_intent:evidence_stale";
  return null;
}
function gatePlan(plan: PrivateSignalPlan): PrivateExecutionGatePlan {
  return { runtimeVersion: plan.runtimeVersion, ruleRevisionId: plan.rule?.revisionId ?? null, risks: plan.risks ? { confirmBeforeTrade: plan.risks.confirmBeforeTrade,
    requireApprovalAboveUsd: plan.risks.requireApprovalAboveUsd, requireApprovalForNewTokens: plan.risks.requireApprovalForNewTokens } : null,
  exit: plan.exit ? { stopLossBps: plan.exit.stopLossBps } : null };
}
const code = (text: string): string => text.replace(/[^a-z0-9_:]/g, "_").slice(0, 96);

/** The token one new buy is for and the owner's "max N positions at a time" it is counted against: N when the owner's rules state it,
 * `"none"` when they never did (no limit, the held mints are not read), null when that cannot be told (refused max_positions_unknown). */
export interface PrivateExecutionEntryBuy { mint: string; maxPositions: PrivateMaxPositions | null }
/** K1b DCA: the gates every new buy passes, shared by signal intents and DCA adds (one sequence, one rate guard, one running start). */
export interface PrivateExecutionSharedGates {
  /** The signal buy's gates up to the keystore, in its order: the entry choke point for `plan`, the S5c entry hold, the owner's max
   * positions for `buy`, the owner's limits, the RPC class and the wallet holds (copy, unfinished attempt, open reservation). Null passes;
   * otherwise the closed refusal. */
  entry(plan: PrivateExecutionGatePlan, buy: PrivateExecutionEntryBuy, nowMs: number): string | null;
  /** After the keystore: no other running start of the agent (signal intent or DCA add) and the per-wallet rate guard over both. */
  start(walletAddress: string, nowMs: number): string | null;
  /** M3.6: Balchemy has accepted the current local armed runtime state. */
  armedSynced(): boolean;
}
/** K1b DCA: the add worker run inside this drain after the signal queue (private-dca-worker.ts). */
export interface PrivateExecutionDcaStep {
  /** Resolves interrupted `running` adds from the journal; true once none is left. Nothing starts before it succeeds. */
  recover(agentId: string): boolean;
  /** Every add's start (a throw refuses the caller's start state_unavailable). */
  starts(agentId: string): readonly { walletAddress: string; startedAt: number; running: boolean }[];
  /** At most one add, through `gates`; never throws. */
  step(agentId: string, gates: PrivateExecutionSharedGates, signal: AbortSignal): Promise<void>;
  readonly pollMs: number;
}
export interface PrivateExecutionWorkerOptions {
  agentIds: readonly string[];
  intents: Pick<PrivateExecutionIntents, "list" | "get" | "admit" | "update">;
  readJob(agentId: string, jobId: string, signal: AbortSignal): Promise<PrivateSignalJob>;
  readRuntime(agentId: string): RunnerAgentState | undefined;
  readFacts(agentId: string): PrivateExecutionLiveFacts;
  readWallet(agentId: string): TradingWalletStatus;
  readRpc(agentId: string): PrivateEffectiveRpcStatus;
  ledger: Pick<PrivateSpendLedger, "status" | "reservation">;
  readAttempts(agentId: string): readonly PrivateSubmissionAttempt[];
  /** The mints the agent holds or is buying (privateHeldMints); null or a throw is unknown and refuses every new buy
   * (max_positions_unknown). */
  readHeldMints(agentId: string): ReadonlySet<string> | null;
  /** The owner's max positions of the confirmed revision `ruleRevisionId` (privateStatedMaxPositions): N when the rules state it,
   * `"none"` when they never did. Null (or a throw) when that revision is not the confirmed head or cannot be read: unknown, refused
   * max_positions_unknown. */
  readMaxPositions(agentId: string, ruleRevisionId: string): PrivateMaxPositions | null;
  /** buildPrivateExecutionCandidate with the agent's own RPC; never throws by contract (a throw is held as ambiguous). */
  build(agentId: string, job: PrivateSignalJob, signal: AbortSignal): Promise<PrivateExecutionBuildOutcome>;
  /** PrivateSubmissions.submit: the one signature, the fsynced journal, then the relay. `expiry` is re-checked by the
   * submission synchronously immediately before signing; a non-null reason refuses the signature. */
  submit(agentId: string, built: PrivateValidatedExecution, signal: AbortSignal, expiry: () => string | null): Promise<PrivateSubmissionOutcome>;
  /** M3.6 F-M36-1: the local runtime version Balchemy has accepted as live_armed + armed under an active lease, else null
   * (RunnerRuntimeBridge.acceptedArmedVersion). A build waits until it equals the current local version. */
  readServerArmed(agentId: string): number | null;
  /** M3.6 F-M36-2: Balchemy has answered this exact event's ACK (RunnerSignalsBridge.acknowledged). A build waits for it. */
  readSignalAcknowledged(agentId: string, eventId: string, eventDigest: string): boolean;
  now?(): number; rateMs?: number; keystoreWaitMs?: number; pollMs?: number; syncWaitMs?: number;
  /** Test-only seam (see private-execution-gate.ts); production never sets it. */
  capabilities?: PrivateExecutionCapabilities;
  /** S5c entry hold, wired only while exits are available (the daemon wires it since S5; absent on the exits-off rollback build,
   * whose buys the gate refuses anyway). Checked right after the
   * entry gate, before any reservation, lock or build: a non-null reason (or a throw: `unavailable`) refuses the intent
   * `exit_hold:<reason>`, so new buys never outrun the protection of earlier ones. */
  entryHold?(agentId: string): string | null;
  /** K1b DCA adds, run in this drain after the signal queue and re-run every `pollMs` (absent: no DCA). */
  dca?: PrivateExecutionDcaStep;
}
type Step = "next" | "wait" | "stop";

export class PrivateExecutionWorker {
  readonly #options: PrivateExecutionWorkerOptions;
  readonly #agentIds: string[];
  readonly #draining = new Map<string, Promise<void>>();
  readonly #again = new Set<string>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  readonly #abort = new AbortController();
  /** Agents whose interrupted `running` intents were resolved in this process. */
  readonly #recovered = new Set<string>();
  /** jobId -> first time its build waited for Balchemy's armed mirror or signal ACK (in memory: a restarted daemon is never armed). */
  readonly #syncSince = new Map<string, number>();
  #closed = false;
  #started = false;
  constructor(options: PrivateExecutionWorkerOptions) { this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds }; }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void {
    // After start, the new agent gets what start gives every agent: its (empty) recovery and one drain.
    if (addRunnerAgent(this.#agentIds, agentId) && this.#started && !this.#closed) { this.#recover(agentId); this.#kick(agentId); }
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }

  /** Daemon start, after S4 start recovery: resolves interrupted `running` intents from the journal (never rebuilt), then
   * drains every queue. An agent whose recovery fails now is recovered again before its next drain. */
  start(): void {
    this.#started = true;
    for (const agentId of this.#options.agentIds) { this.#recover(agentId); this.#kick(agentId); }
  }

  /** Resolves this agent's interrupted `running` intents from the journal only. True once nothing is left running. */
  #recover(agentId: string): boolean {
    if (this.#options.dca && !this.#options.dca.recover(agentId)) return false;
    if (this.#recovered.has(agentId)) return true;
    try {
      for (const intent of this.#options.intents.list(agentId).filter((item) => item.state === "running")) {
        const attempt = this.#attemptFor(agentId, intent.jobId);
        this.#options.intents.update(agentId, intent.jobId, "running", attempt ? { state: "submitted", attemptKey: attempt.attemptKey, reason: null }
          : { state: "refused", reason: "interrupted" }, this.#now());
      }
      this.#recovered.add(agentId); return true;
    } catch { return false; /* A held store keeps the intent unresolved; nothing in it can start. */ }
  }

  /** Called once a signal job completes. Idempotent; throws only when the store cannot record the admission. */
  enqueue(job: PrivateSignalJob): PrivateExecutionIntent | undefined {
    if (this.#closed || !this.#options.agentIds.includes(job.agentId)) return undefined;
    const admission = privateExecutionAdmission(job);
    if (!admission) return undefined;
    const { intent } = this.#options.intents.admit(job.agentId, { jobId: job.jobId, state: admission.state, reason: admission.reason,
      observedAt: Date.parse(job.receipt.signal.observedAt), planDigest: job.result?.plan?.digest ?? null }, this.#now());
    if (intent.state === "queued") this.#kick(job.agentId);
    return intent;
  }

  /** Re-checks a waiting queue now (Balchemy accepted a heartbeat or answered an ACK); otherwise a no-op. */
  wake(agentId: string): void {
    if (!this.#closed && this.#options.agentIds.includes(agentId) && this.#timers.has(agentId)) this.#kick(agentId);
  }

  outcome(agentId: string, jobId: string): PrivateExecutionOutcomeView | undefined {
    const intent = this.#options.intents.get(agentId, jobId); return intent ? this.#view(agentId, intent) : undefined;
  }
  outcomes(agentId: string): ReadonlyMap<string, PrivateExecutionOutcomeView> {
    const intents = this.#options.intents.list(agentId);
    const attempts = intents.some((item) => item.attemptKey) ? this.#options.readAttempts(agentId) : [];
    return new Map(intents.map((intent) => [intent.jobId, this.#view(agentId, intent, attempts)]));
  }
  status(agentId: string): PrivateExecutionQueueStatus {
    const intents = this.#options.intents.list(agentId);
    const done = intents.filter((item) => terminal(item.state)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return { queued: intents.filter((item) => item.state === "queued").length, running: intents.filter((item) => item.state === "running").length,
      waiting: intents.some((item) => item.state === "queued" && item.waitingSince !== null) ? "keystore_locked" : null,
      last: done ? { jobId: done.jobId, state: done.state, reason: done.reason, updatedAt: done.updatedAt } : null };
  }
  /** True while this agent has queued or running intents. */
  active(agentId: string): boolean { return this.#options.intents.list(agentId).some((item) => !terminal(item.state)); }
  /** Test/shutdown seam: resolves once no drain is in flight (timers may still be pending). */
  async idle(): Promise<void> { while (this.#draining.size > 0) await Promise.all([...this.#draining.values()]); }

  async close(): Promise<void> {
    this.#closed = true; this.#abort.abort();
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    await this.idle().catch(() => undefined);
  }

  #view(agentId: string, intent: PrivateExecutionIntent, attempts?: readonly PrivateSubmissionAttempt[]): PrivateExecutionOutcomeView {
    let trade: PrivateSubmissionState | null = null;
    if (intent.attemptKey) trade = (attempts ?? this.#options.readAttempts(agentId)).find((item) => item.attemptKey === intent.attemptKey)?.state ?? null;
    return { state: intent.state, reason: intent.reason, attemptKey: intent.attemptKey, trade, updatedAt: intent.updatedAt };
  }
  #attemptFor(agentId: string, jobId: string): PrivateSubmissionAttempt | undefined {
    return this.#options.readAttempts(agentId).find((item) => this.#options.ledger.reservation(agentId, item.reservationId)?.jobId === jobId);
  }
  #kick(agentId: string): void {
    if (this.#closed) return;
    if (this.#draining.has(agentId)) { this.#again.add(agentId); return; }
    const timer = this.#timers.get(agentId); if (timer) { clearTimeout(timer); this.#timers.delete(agentId); }
    const work = this.#drain(agentId).catch(() => undefined).finally(() => {
      this.#draining.delete(agentId);
      if (this.#again.delete(agentId)) this.#kick(agentId);
    });
    this.#draining.set(agentId, work);
  }
  async #drain(agentId: string): Promise<void> {
    // No intent starts before this agent's interrupted `running` intents are resolved (retried here when start failed).
    if (!this.#recover(agentId)) return;
    for (;;) {
      if (this.#closed) return;
      let next: PrivateExecutionIntent | undefined;
      try { next = this.#options.intents.list(agentId).filter((item) => item.state === "queued").sort((a, b) => a.createdAt - b.createdAt)[0]; } catch { return; }
      if (!next) { await this.#dca(agentId); return; }
      const step = await this.#process(agentId, next);
      if (step === "stop") return;
      if (step === "wait") {
        if (this.#closed) return;
        const timer = setTimeout(() => { this.#timers.delete(agentId); this.#kick(agentId); }, this.#options.pollMs ?? PRIVATE_EXECUTION_POLL_MS);
        timer.unref(); this.#timers.set(agentId, timer); return;
      }
    }
  }

  /** K1b DCA: at most one add through the shared gates, then the next DCA poll is scheduled (an earlier wait timer is kept). */
  async #dca(agentId: string): Promise<void> {
    const dca = this.#options.dca;
    if (!dca || this.#closed) return;
    await dca.step(agentId, this.#gates(agentId), this.#abort.signal);
    if (this.#closed || this.#timers.has(agentId)) return;
    const timer = setTimeout(() => { this.#timers.delete(agentId); this.#kick(agentId); }, dca.pollMs);
    timer.unref(); this.#timers.set(agentId, timer);
  }
  #gates(agentId: string): PrivateExecutionSharedGates {
    const entry = (plan: PrivateExecutionGatePlan, buy: PrivateExecutionEntryBuy, nowMs: number): string | null => {
      const result = this.#entryGates(agentId, plan, { mint: buy.mint, maxPositions: () => buy.maxPositions }, nowMs);
      return typeof result === "string" ? result : null;
    };
    return { entry, start: (walletAddress, nowMs) => this.#startGate(agentId, walletAddress, null, nowMs),
      armedSynced: () => this.#armedSynced(agentId) };
  }
  /** The shared gates up to the keystore (see PrivateExecutionSharedGates.entry); the spend status on success. The buy's max positions
   * is read only once the choke point and the entry hold passed (a throw is unknown). */
  #entryGates(agentId: string, plan: PrivateExecutionGatePlan, buy: { mint: string; maxPositions: () => PrivateMaxPositions | null },
    now: number): string | { spend: PrivateSpendStatus } {
    const o = this.#options;
    const read = <T>(reader: () => T): T | undefined => { try { return reader(); } catch { return undefined; } };
    const gate = privateExecutionGate(read(() => o.readRuntime(agentId)), { step: "entry_build", agentId, plan, facts: read(() => o.readFacts(agentId)) },
      o.capabilities);
    if (gate) return gate;
    if (o.entryHold) {
      let hold: string | null;
      try { hold = o.entryHold(agentId); } catch { hold = "unavailable"; }
      if (hold !== null) return `exit_hold:${hold}`;
    }
    // Before the wallet holds, so an unopened buy of another mint is counted (not only reported as wallet_held).
    const positions = privateMaxPositionsRefusal(() => o.readHeldMints(agentId), buy.mint, read(buy.maxPositions) ?? null);
    if (positions) return positions;
    const spend = read(() => o.ledger.status(agentId, now));
    if (!spend) return "state_unavailable";
    // `unset` (never answered) refuses; an explicit `none` is a valid answer (the build sends it as dailyCap `none`, see private-execution-build).
    if (!spend.configured) return "limits_missing";
    const rpc = read(() => o.readRpc(agentId));
    if (!rpc) return "state_unavailable";
    if (!rpc.endpoint) return "rpc_missing";
    if (!privateRpcClassExecutable(rpc.endpoint.class)) return "rpc_public";
    const attempts = read(() => o.readAttempts(agentId));
    if (!attempts) return "state_unavailable";
    if (attempts.some(privateSubmissionCopyHeld)) return "copy_unacknowledged";
    if (attempts.some((item) => !isPrivateSubmissionTerminal(item.state)) || spend.open.length > 0) return "wallet_held";
    return { spend };
  }
  /** One running start per agent across signal intents and DCA adds, and the per-wallet rate guard over both (`self`: the intent
   * being started, null for an add). */
  #startGate(agentId: string, walletAddress: string, self: string | null, now: number): string | null {
    const o = this.#options;
    let earlier: readonly PrivateExecutionIntent[]; let adds: readonly { walletAddress: string; startedAt: number; running: boolean }[];
    try { earlier = o.intents.list(agentId); adds = o.dca ? o.dca.starts(agentId) : []; } catch { return "state_unavailable"; }
    // One running intent per agent (wallet): a stuck one is resolved by recovery, never overtaken.
    if (earlier.some((item) => item.state === "running" && item.jobId !== self) || adds.some((item) => item.running)) return "intent_running";
    const last = Math.max(-Infinity, ...earlier.filter((item) => item.walletAddress === walletAddress && item.startedAt !== null).map((item) => item.startedAt as number),
      ...adds.filter((item) => item.walletAddress === walletAddress).map((item) => item.startedAt));
    if (now - last < (o.rateMs ?? PRIVATE_EXECUTION_RATE_MS)) return "rate_limited";
    return null;
  }
  #armedSynced(agentId: string): boolean {
    const o = this.#options;
    try { const version = o.readRuntime(agentId)?.version; const armed = o.readServerArmed(agentId); return version !== undefined && armed !== null && armed === version; }
    catch { return false; }
  }
  /** Null once Balchemy mirrors the current local armed state and has answered this signal's ACK; a read failure waits too. */
  #unsynced(agentId: string, job: PrivateSignalJob): "arm_unconfirmed" | "signal_ack_unconfirmed" | null {
    const o = this.#options;
    let version: number | undefined, armed: number | null;
    try { version = o.readRuntime(agentId)?.version; armed = o.readServerArmed(agentId); } catch { return "arm_unconfirmed"; }
    if (version === undefined || armed === null || armed !== version) return "arm_unconfirmed";
    const event = job.receipt.signal;
    try { return o.readSignalAcknowledged(agentId, event.eventId, event.eventDigest) === true ? null : "signal_ack_unconfirmed"; }
    catch { return "signal_ack_unconfirmed"; }
  }

  /** One intent, one recorded outcome (or a bounded keystore or Balchemy-sync wait). */
  async #process(agentId: string, intent: PrivateExecutionIntent): Promise<Step> {
    const o = this.#options; const signal = this.#abort.signal;
    const move = (from: PrivateExecutionIntentState, change: PrivateExecutionIntentChange): Step => {
      try { o.intents.update(agentId, intent.jobId, from, change, Math.max(this.#now(), intent.updatedAt)); }
      catch { return "stop"; }
      this.#syncSince.delete(intent.jobId); return "next";
    };
    const finish = (state: PrivateExecutionIntentState, reason: string | null, from: PrivateExecutionIntentState = "queued", extra: PrivateExecutionIntentChange = {}): Step =>
      move(from, { state, reason: reason === null ? null : code(reason), waitingSince: null, ...extra });
    let job: PrivateSignalJob;
    try { job = await o.readJob(agentId, intent.jobId, signal); } catch { return this.#closed ? "stop" : finish("refused", "job_unavailable"); }
    if (this.#closed) return "stop";
    const now = this.#now();
    const admission = job.jobId === intent.jobId && job.agentId === agentId ? privateExecutionAdmission(job) : null;
    const plan = job.result?.plan;
    if (!admission || !plan || (plan.digest !== intent.planDigest)) return finish("refused", "job_not_executable");
    if (admission.state !== "queued") return finish("not_executed", admission.reason);
    const expired = privateExecutionExpiry(job, now);
    if (expired) return finish("expired", expired);
    const read = <T>(reader: () => T): T | undefined => { try { return reader(); } catch { return undefined; } };
    // The owner's max positions of the plan's own revision: N is the plan's (risk.maxConcurrentPositions); whether the rules state it is
    // read from that confirmed revision. A stated N other than the plan's is unknown (refused).
    const maxPositions = (): PrivateMaxPositions | null => {
      const rule = plan.rule;
      const stated = rule ? o.readMaxPositions(agentId, rule.revisionId) : null;
      return stated === "none" || (stated !== null && stated === plan.risks?.maxConcurrentPositions) ? stated : null;
    };
    // The gates every new buy shares with a DCA add (one sequence, see PrivateExecutionSharedGates).
    const entry = this.#entryGates(agentId, gatePlan(plan), { mint: plan.asset.assetId, maxPositions }, now);
    if (typeof entry === "string") return finish("refused", entry);
    const wallet = read(() => o.readWallet(agentId));
    if (!wallet || wallet.state === "held") return finish("refused", "state_unavailable");
    if (wallet.state === "absent") return finish("refused", "wallet_missing");
    if (wallet.state !== "unlocked" || !wallet.addressVerified) {
      const since = intent.waitingSince ?? now;
      if (now - since >= (o.keystoreWaitMs ?? PRIVATE_EXECUTION_KEYSTORE_WAIT_MS)) return finish("refused", "keystore_locked");
      if (intent.waitingSince === null && move("queued", { waitingSince: now, reason: "waiting:keystore_locked" }) === "stop") return "stop";
      return "wait";
    }
    // Rate guard: one new buy per wallet per window, counted from every earlier start (whatever its outcome), DCA adds included; and
    // one running start per agent across intents and adds.
    const started = this.#startGate(agentId, wallet.address, intent.jobId, now);
    if (started) return finish("refused", started);
    // M3.6: never request a build Balchemy must refuse only because it has not yet seen this runner's arm (the next heartbeat
    // reports it) or this signal's ACK (sent after the durable receipt, 1 s proof spacing). Wait, bounded; nothing is reserved.
    const unsynced = this.#unsynced(agentId, job);
    if (unsynced) {
      const since = this.#syncSince.get(intent.jobId) ?? now; this.#syncSince.set(intent.jobId, since);
      return now - since >= (o.syncWaitMs ?? PRIVATE_EXECUTION_SYNC_WAIT_MS) ? finish("refused", unsynced) : "wait";
    }
    // Durable before any reservation or network call: a crash from here is resolved from the journal, never rebuilt.
    if (move("queued", { state: "running", startedAt: now, walletAddress: wallet.address, waitingSince: null, reason: null }) === "stop") return "stop";
    let built: PrivateExecutionBuildOutcome;
    try { built = await o.build(agentId, job, signal); }
    catch { return finish("held", "build_outcome_unknown", "running"); }
    if (built.outcome === "unknown") return finish("held", "build_outcome_unknown", "running");
    if (built.outcome === "refused") return finish("refused", `build:${built.stage}:${built.reason}`, "running");
    let submitted: PrivateSubmissionOutcome;
    try { submitted = await o.submit(agentId, built, signal, () => privateExecutionExpiry(job, this.#now())); }
    catch { return finish("held", "submit_outcome_unknown", "running"); }
    if (submitted.outcome === "refused") {
      if (submitted.reason === "attempt_exists") {
        const attempt = read(() => this.#attemptFor(agentId, intent.jobId));
        if (attempt) return finish("submitted", null, "running", { attemptKey: attempt.attemptKey });
      }
      return finish(submitted.reservation === "released" ? "refused" : "held", `submit:${submitted.reason}`, "running");
    }
    if (submitted.outcome === "unknown") return finish("held", submitted.reason, "running");
    return finish("submitted", submitted.reason, "running", { attemptKey: submitted.attemptKey });
  }
}
