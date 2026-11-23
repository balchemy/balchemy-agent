import { validateRunnerBrainObservation, validateRunnerKeystoreObservation, type RunnerBrainObservation, type RunnerKeystoreObservation } from "@balchemyai/agent-sdk";
import { parsePrivateCapSetting, parsePrivateSpendRemaining, privateSpendRemaining, type PrivateCapSetting, type PrivateSpendRemaining } from "./private-spend-cap.js";
/** Local control only. No credentials, strategy text, signing or trading payloads. The plain control action `arm`
 * is always refused (`execution_unavailable`): arming exists only on the passphrase-verified private arming channel. */
export const RUNNER_PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 16 * 1024;
export const CONTROL_ACTIONS = ["status", "pause", "resume", "disarm", "stop", "arm"] as const;
export type ControlAction = typeof CONTROL_ACTIONS[number];
export type MutationAction = Exclude<ControlAction, "status">;
export type RunnerRequest = {
  version: 1;
  id: string;
  agentId: string;
} & ({ action: "status" } | { action: MutationAction; expectedVersion: number });

export interface RunnerDaemonRequest {
  version: 1;
  id: string;
  /** `daemon_version` (0.5.0+) answers with `daemon.packageVersion`; an older daemon rejects it, which reads as "older". */
  action: "daemon_status" | "daemon_version" | "agent_list" | "shutdown";
  instanceId: string;
}
/** Owner decision of 19 Nov 2026: adds an agent to the RUNNING daemon (owner-local socket only; never a control action, so Hub and the
 * control bridge cannot send it). Bound to the current instance like the daemon requests. An older daemon rejects it (invalid_request).
 * The reply carries the agent's `state` and `registration` ("added", or "existing" when it was already registered: nothing changed). */
export interface RunnerRegisterRequest {
  version: 1;
  id: string;
  action: "register_agent";
  instanceId: string;
  agentId: string;
}
export type LocalRunnerRequest = RunnerRequest | RunnerDaemonRequest | RunnerRegisterRequest;
export const RUNNER_REGISTRATIONS = ["added", "existing"] as const;
export type RunnerRegistration = typeof RUNNER_REGISTRATIONS[number];
export interface RunnerInventory { instanceId: string; agentIds: string[] }
export interface RunnerDaemonState {
  instanceId: string;
  process: "running" | "stopping";
  pairing: "unpaired";
  brain: "not_attached";
  armed: false;
  execution: "unavailable";
  /** Only on a `daemon_version` reply, never on daemon_status: an older CLI parses daemon_status with exact keys. */
  packageVersion?: string;
}
/** A package version as published (semver with an optional pre-release or build tag). */
export const PACKAGE_VERSION_PATTERN = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,64})?$/;

/** `live_unarmed` is live-configured but never executes; `live_armed` (only via the owner's CLI `runner arm`, never the
 * web or the server) is the only mode with `armed: true`. Older runners report shadow/paused only; both still parse. */
export const RUNNER_AGENT_MODES = ["shadow", "paused", "live_unarmed", "live_armed"] as const;
export type RunnerAgentMode = typeof RUNNER_AGENT_MODES[number];
/** New autonomous entries of a live_armed agent. Owner pause (web or CLI) on live_armed keeps it armed with entries
 * `paused`: no new buy is built or signed, protective exits stay allowed. Present exactly when mode is live_armed. */
export const RUNNER_AGENT_ENTRIES = ["enabled", "paused"] as const;
export type RunnerAgentEntries = typeof RUNNER_AGENT_ENTRIES[number];
export interface RunnerAgentState {
  agentId: string;
  version: number;
  mode: RunnerAgentMode;
  lifecycle: "idle" | "stopped";
  /** True exactly when mode is live_armed. */
  armed: boolean;
  /** Autonomous execution attachment; still unavailable in this version, also while armed. */
  execution: "unavailable";
  updatedAt: number;
  /** Only with live_armed (always present there); absent in every other mode and in older states. */
  entries?: RunnerAgentEntries;
}
/** Shared mode invariant: stopped implies paused, and armed is true exactly for live_armed. */
export function isRunnerModeState(mode: unknown, lifecycle: unknown, armed: unknown): boolean {
  return RUNNER_AGENT_MODES.includes(mode as RunnerAgentMode) && (lifecycle === "idle" || lifecycle === "stopped")
    && (lifecycle !== "stopped" || mode === "paused") && typeof armed === "boolean" && armed === (mode === "live_armed");
}
/** `entries` is present (enabled | paused) exactly when mode is live_armed; `undefined` means the key is absent. */
export function isRunnerEntriesState(mode: unknown, entries: unknown): boolean {
  return mode === "live_armed" ? RUNNER_AGENT_ENTRIES.includes(entries as RunnerAgentEntries) : entries === undefined;
}
/** Runtime-state keys: the fixed set plus `entries` exactly for live_armed. */
export function runnerAgentStateKeys(value: unknown): string[] {
  const keys = ["agentId", "version", "mode", "lifecycle", "armed", "execution", "updatedAt"];
  return isRecord(value) && value.mode === "live_armed" ? [...keys, "entries"] : keys;
}

/** Ephemeral Hub acknowledgement, never part of the durable agent/control journal. */
export interface RunnerHubStatus {
  connection: "not_paired" | "connecting" | "reporting" | "unavailable";
  serverAgentId?: string;
  lastConfirmedAt?: string;
  /** Final audit N5: present only while `unavailable` because Balchemy's answer proved this computer's clock differs from Balchemy's
   * by more than 5 s. The one closed literal; never the error text, a provider body or a key. */
  reason?: RunnerHubReason;
}
export const RUNNER_HUB_REASONS = ["clock_skew"] as const;
export type RunnerHubReason = typeof RUNNER_HUB_REASONS[number];
/** Owner text of RunnerHubReason "clock_skew" (final audit N5), shown once per output. */
export const RUNNER_CLOCK_SKEW_TEXT = "This computer's clock differs from Balchemy's by more than 5 seconds, so Balchemy's answers are refused. Turn on automatic time sync, then the runner reconnects by itself.";
/** The exit worker's reasons (last pass or backoff, exact) that a missing Hub lease produces: the clock text is shown beside them
 * while the Hub reason is clock_skew. */
export const RUNNER_LEASE_LOST_EXIT_REASONS: readonly string[] = ["valuation_unavailable", "valuation:unavailable", "build:local:lease_unavailable",
  "submit:lease_unavailable"];

export const ERROR_CODES = [
  "invalid_request", "unknown_agent", "version_conflict", "id_conflict",
  "execution_unavailable", "journal_full", "state_unavailable", "closing", "instance_conflict",
  /** register_agent only: the runner already holds the maximum of 64 agents. */
  "agent_limit",
] as const;
export type RunnerErrorCode = typeof ERROR_CODES[number];
export type RunnerResponse = {
  version: 1;
  id: string | null;
  ok: boolean;
  /** Current for status; immutable historical acknowledgement for a mutation. */
  state?: RunnerAgentState;
  daemon?: RunnerDaemonState;
  inventory?: RunnerInventory;
  hub?: RunnerHubStatus;
  /** Current status only; never attached to historical mutation receipts. */
  brainObservation?: RunnerBrainObservation;
  /** Current status only, on every per-agent status reply: the keystore lock and this runner's exit capability. */
  keystoreObservation?: RunnerKeystoreObservation;
  /** Current status only, present when a trade landed under a signature this runner never made (unacknowledged). */
  submissionSecurity?: RunnerSubmissionSecurity;
  /** Current status only, while live_armed or while execution intents are queued/running (S8b). */
  executionStatus?: RunnerExecutionStatus;
  /** register_agent replies only (with `state`): whether this request added the agent or found it already registered. */
  registration?: RunnerRegistration;
  error?: RunnerErrorCode;
};
/** S8b summary of the autonomous execution path: keystore, owner caps and the execution queue. Public facts only. Local
 * owner IPC only (daemon -> CLI); it is never sent to Balchemy and is not part of any signed proof. */
export interface RunnerExecutionStatus {
  keystore: "absent" | "locked" | "unlocked" | "held" | "unavailable";
  /** S4: each cap is `unset` (never answered: nothing can be spent), `none` (the owner's explicit no limit) or an amount;
   * remaining is `unset`, `unlimited` or an amount. No bare null; "unavailable" only when the ledger could not be read. */
  limits: { perTrade: PrivateCapSetting; daily: PrivateCapSetting; remaining: PrivateSpendRemaining } | "unavailable";
  queue: { queued: number; running: number; waiting: "keystore_locked" | null;
    last: { jobId: string; state: string; reason: string | null; updatedAt: number } | null } | "unavailable";
  /** M3: the exit worker and position ledger summary. Present only while the exits capability is available (since S5; never on
   * the exits-off rollback build); "unavailable" when the ledger or worker could not be read. Details: `runner positions`. */
  exits?: RunnerExitSummary | "unavailable";
  /** K1b DCA: the add worker's last reason (null: nothing waits) and the mints it holds back with why (private-dca-worker.ts status).
   * Present only while DCA adds run here; absent parses as before. */
  dca?: RunnerDcaStatus;
}
/** A type alias (not an interface) so the status stays assignable to the CLI's JSON output. */
export type RunnerDcaStatus = { reason: string | null; holds: { mint: string; reason: string }[] };
/** Holds reported per agent (the newest few; the worker keeps at most one per mint). */
export const RUNNER_DCA_STATUS_MAX_HOLDS = 16;
const DCA_REASON = /^[a-z0-9_:]{1,96}$/;
const DCA_MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function parseDcaStatus(value: unknown): void {
  if (!isRecord(value) || !exactKeys(value, ["reason", "holds"]) || (value.reason !== null && (typeof value.reason !== "string" || !DCA_REASON.test(value.reason)))
    || !Array.isArray(value.holds) || value.holds.length > RUNNER_DCA_STATUS_MAX_HOLDS
    || value.holds.some((item: unknown) => !isRecord(item) || !exactKeys(item, ["mint", "reason"]) || typeof item.mint !== "string" || !DCA_MINT.test(item.mint)
      || typeof item.reason !== "string" || !DCA_REASON.test(item.reason))) throw new RunnerProtocolError();
}
/** Why the exit worker refuses new buys right now (H1d entry hold); "unavailable" when the worker could not answer (a buy is refused).
 * `buy_unprotected` (final audit S3): a completed buy's position was refused permanently, so its tokens have no stop-loss; it never
 * lifts by itself. */
export const RUNNER_EXIT_ENTRY_HOLDS = ["attempt_released_unsettled", "position_held", "exit_pending", "position_unopened", "buy_unprotected", "ledger_full",
  "unavailable"] as const;
export type RunnerExitEntryHold = typeof RUNNER_EXIT_ENTRY_HOLDS[number];
/** Held positions listed in the status summary (the full list is `runner positions`). */
export const RUNNER_EXIT_SUMMARY_HELD_LIMIT = 4;
/** F2: why S4 has not released a runner dispute yet (process-local, closed set). `wire_blockhash_mismatch` is permanent (never
 * retried); `gate_refused` (halted, disarmed or not the owner's own RPC) is retried only once the gate admits again; every other
 * reason is retried after a back-off. Shown by `runner trades` (per attempt) and `runner status`.
 * SF R10 (owner decision 27, docs/product/drafts/M3-SF1-SF2-HISTORY-AND-RESERVATION-DESIGN.md): the same check of a buy Balchemy leaves
 * unresolved adds `stall_grace` (the first proof held; the 30-minute wait runs), `buy_landed` (the runner's own RPC showed it landed:
 * nothing is released and, like wire_blockhash_mismatch, it is permanent for the process: no later proof runs, so a later absence on
 * an inconsistent RPC can never release it; Balchemy should complete it) and the unproven reasons of the buy proof (R2), none of them
 * counted here. */
export const RUNNER_LANDING_RELEASE_REASONS = ["wire_blockhash_mismatch", "rpc_missing", "rpc_unavailable", "expiry_unproven", "proof_regressed",
  "gate_refused", "state_unavailable", "attempt_changed", "journal_unavailable", "stall_grace", "buy_landed", "balance_unexplained", "no_witness",
  "witness_unproven", "transaction_malformed", "rpc_lagging", "transaction_appeared"] as const;
export type RunnerLandingReleaseReason = typeof RUNNER_LANDING_RELEASE_REASONS[number];
/** F2 readback wording of a release reason's retry, shared by `runner trades` and `runner status`. A disarmed bot cannot re-arm
 * while the dispute is open (submission_unresolved), so gate_refused never claims an automatic retry. */
export function runnerLandingReleaseRetry(reason: RunnerLandingReleaseReason): string {
  if (reason === "wire_blockhash_mismatch") return "permanent: the stored bytes do not match their blockhash; never retried, owner review";
  if (reason === "gate_refused") return "retried only while armed on your own RPC; a disarmed bot cannot re-arm while this dispute is open, owner review";
  if (reason === "stall_grace") return "the blockhash expired on your RPC; checked again after 30 minutes";
  if (reason === "buy_landed") return "permanent: your RPC showed it landed; nothing is released and it is not checked again in this run, waiting for Balchemy";
  return "retried automatically while armed";
}
/** SF2 (docs/product/drafts/M3-SF1-SF2-HISTORY-AND-RESERVATION-DESIGN.md, R2): why the runner has not yet proven, on its own RPC,
 * that a buy Balchemy reports failed or expired did not land (process-local, closed set). The first five MAY BE COUNTED (every read
 * succeeded at or past a finalized slot F after the blockhash expired, so the bytes can no longer land): three of them at strictly
 * increasing F, the first and the last at least 10 minutes apart, with the same reason and balance, make the outcome permanent
 * (dispute `runner:buy_negative_unproven:<reason>`). `transaction_appeared` is counted only for a not_landed from absence after a
 * sighting (the runner's RPC showed the buy earlier, so absence never releases it); while the RPC shows the buy it is not counted.
 * The rest are never counted. Shown by `runner trades` while the buy is held. */
export const RUNNER_BUY_CHECK_COUNTED = ["balance_unexplained", "no_witness", "witness_unproven", "transaction_malformed", "transaction_appeared"] as const;
export const RUNNER_BUY_CHECK_REASONS = [...RUNNER_BUY_CHECK_COUNTED, "rpc_missing", "rpc_unavailable", "expiry_unproven", "rpc_lagging",
  "gate_refused", "state_unavailable", "attempt_changed", "journal_unavailable"] as const;
export type RunnerBuyCheckReason = typeof RUNNER_BUY_CHECK_REASONS[number];
/** Counted results that make an unproven buy negative permanent (R2). */
export const RUNNER_BUY_CHECK_PERMANENT_COUNT = 3;
/** Owner decision 26 (`runner trades <agent> close <attempt>`): why the owner's close-out of one attempt did not close it (closed set).
 * The attempt always stays held (never closed_by_owner). Every refusal leaves the attempt, the spend and the positions exactly as they
 * were, except four write failures, which are only ever more conservative and which the next close-out completes (each write is
 * idempotent): `mint_unavailable` and `position_unavailable` (the failing write itself may have landed), `partly_applied` (the coin
 * was kept off automatic management, or the spend commit may have landed, before a later step failed) and `journal_unavailable`
 * (the close-out itself may or may not have been written: the CLI reports the outcome as unknown). */
export const RUNNER_TRADE_CLOSE_REFUSALS = ["confirmation_mismatch", "attempt_missing", "terminal", "copy_unacknowledged", "not_closable",
  "runtime_not_idle", "rpc_not_owned", "rpc_missing", "rpc_unavailable", "wire_blockhash_mismatch", "expiry_unproven", "proof_regressed",
  "attempt_changed", "spend_missing", "spend_released", "mint_unavailable", "position_unavailable", "state_unavailable", "journal_unavailable",
  "partly_applied", "busy", "closing"] as const;
export type RunnerTradeCloseRefusal = typeof RUNNER_TRADE_CLOSE_REFUSALS[number];
/** Release checks listed in the status summary (the full list is `runner trades`). */
export const RUNNER_EXIT_SUMMARY_RELEASE_LIMIT = 4;
/** A type alias (not an interface) so the CLI's JSON status output stays assignable to JsonValue. */
export type RunnerExitSummary = {
  entryHold: RunnerExitEntryHold | null;
  /** The exit worker's last pass reason (bounded code), or null. */
  reason: string | null;
  /** Positions open without a pending exit, open with a pending exit, and held for review. */
  open: number; pending: number; held: number;
  /** Completed buys without a position yet, and positions waiting out a refusal backoff (process-local). */
  unopened: number; backoff: number;
  heldPositions: Array<{ positionId: string; holdReason: string }>;
  /** F2: runner disputes not released yet and why (at most RUNNER_EXIT_SUMMARY_RELEASE_LIMIT); absent when there is none. */
  releaseChecks?: Array<{ attemptKey: string; reason: RunnerLandingReleaseReason }>;
};
const REASON_CODE = /^[a-z0-9_:]{1,96}$/;
const POSITION_ID = /^pos:[0-9a-f]{32}$/;
function parseExitSummary(value: unknown, count: (item: unknown) => boolean): void {
  if (value === "unavailable") return;
  const keys = ["entryHold", "reason", "open", "pending", "held", "unopened", "backoff", "heldPositions"];
  if (isRecord(value) && Object.hasOwn(value, "releaseChecks")) {
    const checks = value.releaseChecks;
    if (!Array.isArray(checks) || checks.length < 1 || checks.length > RUNNER_EXIT_SUMMARY_RELEASE_LIMIT
      || checks.some((item: unknown) => !isRecord(item) || !exactKeys(item, ["attemptKey", "reason"])
        || typeof item.attemptKey !== "string" || !/^att:[0-9a-f]{32}$/.test(item.attemptKey)
        || !RUNNER_LANDING_RELEASE_REASONS.includes(item.reason as RunnerLandingReleaseReason))) throw new RunnerProtocolError();
    keys.push("releaseChecks");
  }
  if (!isRecord(value) || !exactKeys(value, keys)
    || (value.entryHold !== null && !RUNNER_EXIT_ENTRY_HOLDS.includes(value.entryHold as RunnerExitEntryHold))
    || (value.reason !== null && (typeof value.reason !== "string" || !REASON_CODE.test(value.reason)))
    || ![value.open, value.pending, value.held, value.unopened, value.backoff].every(count)
    || !Array.isArray(value.heldPositions) || value.heldPositions.length > RUNNER_EXIT_SUMMARY_HELD_LIMIT
    || value.heldPositions.length > (value.held as number)
    || value.heldPositions.some((item: unknown) => !isRecord(item) || !exactKeys(item, ["positionId", "holdReason"])
      || typeof item.positionId !== "string" || !POSITION_ID.test(item.positionId)
      || typeof item.holdReason !== "string" || !REASON_CODE.test(item.holdReason))) throw new RunnerProtocolError();
}
/** Mirrors PRIVATE_EXECUTION_INTENT_STATES (kept here: this module is imported by every runner channel). */
const EXECUTION_INTENT_STATES = ["queued", "running", "submitted", "refused", "not_executed", "expired", "held"];
export function parseExecutionStatus(value: unknown): RunnerExecutionStatus {
  const count = (item: unknown): boolean => typeof item === "number" && Number.isSafeInteger(item) && item >= 0 && item <= 256;
  if (!isRecord(value) || !exactKeys(value, ["keystore", "limits", "queue", ...(Object.hasOwn(value, "exits") ? ["exits"] : []), ...(Object.hasOwn(value, "dca") ? ["dca"] : [])])
    || !["absent", "locked", "unlocked", "held", "unavailable"].includes(value.keystore as string)) throw new RunnerProtocolError();
  if (Object.hasOwn(value, "exits")) parseExitSummary(value.exits, count);
  if (Object.hasOwn(value, "dca")) parseDcaStatus(value.dca);
  const limits = value.limits;
  if (limits !== "unavailable") {
    if (!isRecord(limits) || !exactKeys(limits, ["perTrade", "daily", "remaining"])) throw new RunnerProtocolError();
    let perTrade: PrivateCapSetting, daily: PrivateCapSetting, remaining: PrivateSpendRemaining;
    try {
      perTrade = parsePrivateCapSetting(limits.perTrade, { allowUnset: true }); daily = parsePrivateCapSetting(limits.daily, { allowUnset: true });
      remaining = parsePrivateSpendRemaining(limits.remaining);
    } catch { throw new RunnerProtocolError(); }
    // Both answered or both unset (a saved revision answers both), and the remaining kind follows the daily cap.
    if ((perTrade.kind === "unset") !== (daily.kind === "unset") || remaining.kind !== privateSpendRemaining(daily, 0n).kind) throw new RunnerProtocolError();
  }
  const queue = value.queue;
  if (queue !== "unavailable") {
    if (!isRecord(queue) || !exactKeys(queue, ["queued", "running", "waiting", "last"]) || !count(queue.queued) || !count(queue.running)
      || (queue.waiting !== null && queue.waiting !== "keystore_locked")) throw new RunnerProtocolError();
    const last = queue.last;
    if (last !== null && (!isRecord(last) || !exactKeys(last, ["jobId", "state", "reason", "updatedAt"]) || typeof last.jobId !== "string"
      || !/^signal_[0-9a-f]{64}$/.test(last.jobId) || !EXECUTION_INTENT_STATES.includes(last.state as string)
      || (last.reason !== null && (typeof last.reason !== "string" || !/^[a-z0-9_:]{1,96}$/.test(last.reason))) || !isTimestamp(last.updatedAt))) throw new RunnerProtocolError();
  }
  return structuredClone(value) as unknown as RunnerExecutionStatus;
}
/** Security warning: the agent's trading wallet key signed a transaction outside Balchemy; new autonomous submissions
 * for that wallet are held until the owner runs `runner wallet <agent> acknowledge-copy`. */
export interface RunnerSubmissionSecurity { unacknowledgedResignedCopies: number }
export function parseSubmissionSecurity(value: unknown): RunnerSubmissionSecurity {
  if (!isRecord(value) || !exactKeys(value, ["unacknowledgedResignedCopies"]) || typeof value.unacknowledgedResignedCopies !== "number"
    || !Number.isSafeInteger(value.unacknowledgedResignedCopies) || value.unacknowledgedResignedCopies < 1 || value.unacknowledgedResignedCopies > 64) {
    throw new RunnerProtocolError();
  }
  return { unacknowledgedResignedCopies: value.unacknowledgedResignedCopies };
}

export class RunnerProtocolError extends Error {
  constructor() { super("Invalid local runner message"); this.name = "RunnerProtocolError"; }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value);
}

export function isVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseRequest(value: unknown): RunnerRequest {
  if (!isRecord(value) || value.version !== 1 || !isId(value.id) || !isId(value.agentId)
    || !CONTROL_ACTIONS.includes(value.action as ControlAction)) throw new RunnerProtocolError();
  const keys = ["version", "id", "agentId", "action"];
  if (value.action !== "status") keys.push("expectedVersion");
  if (!exactKeys(value, keys) || (value.action !== "status" && !isVersion(value.expectedVersion))) {
    throw new RunnerProtocolError();
  }
  return value as RunnerRequest;
}

export function parseLocalRequest(value: unknown): LocalRunnerRequest {
  if (isRecord(value) && (value.action === "daemon_status" || value.action === "daemon_version" || value.action === "agent_list" || value.action === "shutdown")) {
    if (!exactKeys(value, ["version", "id", "action", "instanceId"]) || value.version !== 1
      || !isId(value.id) || !isId(value.instanceId)) throw new RunnerProtocolError();
    return value as unknown as RunnerDaemonRequest;
  }
  if (isRecord(value) && value.action === "register_agent") {
    if (!exactKeys(value, ["version", "id", "action", "instanceId", "agentId"]) || value.version !== 1
      || !isId(value.id) || !isId(value.instanceId) || !isId(value.agentId)) throw new RunnerProtocolError();
    return value as unknown as RunnerRegisterRequest;
  }
  return parseRequest(value);
}

export function parseDaemonState(value: unknown): RunnerDaemonState {
  const keys = ["instanceId", "process", "pairing", "brain", "armed", "execution"];
  if (isRecord(value) && Object.hasOwn(value, "packageVersion")) {
    keys.push("packageVersion");
    if (typeof value.packageVersion !== "string" || !PACKAGE_VERSION_PATTERN.test(value.packageVersion)) throw new RunnerProtocolError();
  }
  if (!isRecord(value) || !exactKeys(value, keys)
    || !isId(value.instanceId) || (value.process !== "running" && value.process !== "stopping")
    || value.pairing !== "unpaired" || value.brain !== "not_attached" || value.armed !== false
    || value.execution !== "unavailable") throw new RunnerProtocolError();
  return value as unknown as RunnerDaemonState;
}

export function parseInventory(value: unknown): RunnerInventory {
  if (!isRecord(value) || !exactKeys(value, ["instanceId", "agentIds"]) || !isId(value.instanceId)
    || !Array.isArray(value.agentIds) || value.agentIds.length === 0 || value.agentIds.length > 64
    || value.agentIds.some((id) => !isId(id)) || new Set(value.agentIds).size !== value.agentIds.length) throw new RunnerProtocolError();
  return value as unknown as RunnerInventory;
}

export function parseAgentState(value: unknown): RunnerAgentState {
  if (!isRecord(value) || !exactKeys(value, runnerAgentStateKeys(value))
    || !isId(value.agentId) || !isVersion(value.version) || !isTimestamp(value.updatedAt)
    || !isRunnerModeState(value.mode, value.lifecycle, value.armed) || !isRunnerEntriesState(value.mode, value.entries)
    || value.execution !== "unavailable") throw new RunnerProtocolError();
  return value as unknown as RunnerAgentState;
}

export function parseResponse(value: unknown): RunnerResponse {
  if (!isRecord(value) || value.version !== 1 || (value.id !== null && !isId(value.id))
    || typeof value.ok !== "boolean") throw new RunnerProtocolError();
  const keys = ["version", "id", "ok"];
  if (Object.hasOwn(value, "state")) { keys.push("state"); parseAgentState(value.state); }
  if (Object.hasOwn(value, "daemon")) { keys.push("daemon"); parseDaemonState(value.daemon); }
  if (Object.hasOwn(value, "inventory")) { keys.push("inventory"); parseInventory(value.inventory); }
  if (Object.hasOwn(value, "hub")) {
    keys.push("hub"); parseHubStatus(value.hub);
    if (!value.ok || !value.state) throw new RunnerProtocolError();
  }
  if (Object.hasOwn(value, "brainObservation")) {
    keys.push("brainObservation"); validateRunnerBrainObservation(value.brainObservation);
    if (!value.ok || !value.state) throw new RunnerProtocolError();
  }
  if (Object.hasOwn(value, "keystoreObservation")) {
    keys.push("keystoreObservation"); validateRunnerKeystoreObservation(value.keystoreObservation);
    if (!value.ok || !value.state) throw new RunnerProtocolError();
  }
  if (Object.hasOwn(value, "submissionSecurity")) {
    keys.push("submissionSecurity"); parseSubmissionSecurity(value.submissionSecurity);
    if (!value.ok || !value.state) throw new RunnerProtocolError();
  }
  if (Object.hasOwn(value, "executionStatus")) {
    keys.push("executionStatus"); parseExecutionStatus(value.executionStatus);
    if (!value.ok || !value.state) throw new RunnerProtocolError();
  }
  if (Object.hasOwn(value, "registration")) {
    keys.push("registration");
    if (!RUNNER_REGISTRATIONS.includes(value.registration as RunnerRegistration) || !value.ok || !value.state) throw new RunnerProtocolError();
  }
  if ([value.state, value.daemon, value.inventory].filter(Boolean).length > 1) throw new RunnerProtocolError();
  if (!value.ok) {
    keys.push("error");
    if (!ERROR_CODES.includes(value.error as RunnerErrorCode)) throw new RunnerProtocolError();
  } else if ((!value.state && !value.daemon && !value.inventory) || value.id === null) throw new RunnerProtocolError();
  if (!exactKeys(value, keys)) throw new RunnerProtocolError();
  return value as RunnerResponse;
}

export function parseHubStatus(value: unknown): RunnerHubStatus {
  if (!isRecord(value) || !["not_paired", "connecting", "reporting", "unavailable"].includes(String(value.connection))) throw new RunnerProtocolError();
  const keys = ["connection"];
  if (Object.hasOwn(value, "serverAgentId")) {
    keys.push("serverAgentId");
    if (typeof value.serverAgentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.serverAgentId)) throw new RunnerProtocolError();
  }
  if (Object.hasOwn(value, "lastConfirmedAt")) {
    keys.push("lastConfirmedAt");
    if (typeof value.lastConfirmedAt !== "string" || !Number.isFinite(Date.parse(value.lastConfirmedAt))
      || new Date(value.lastConfirmedAt).toISOString() !== value.lastConfirmedAt || !value.serverAgentId) throw new RunnerProtocolError();
  }
  if (Object.hasOwn(value, "reason")) {
    keys.push("reason");
    if (value.connection !== "unavailable" || !(RUNNER_HUB_REASONS as readonly unknown[]).includes(value.reason)) throw new RunnerProtocolError();
  }
  if (!exactKeys(value, keys) || (value.connection === "not_paired" && keys.length !== 1)
    || (value.connection === "connecting" && !value.serverAgentId)
    || (value.connection === "reporting" && (!value.serverAgentId || !value.lastConfirmedAt))) throw new RunnerProtocolError();
  return value as unknown as RunnerHubStatus;
}

export function failure(id: string | null, error: RunnerErrorCode, state?: RunnerAgentState): RunnerResponse {
  return { version: 1, id, ok: false, error, ...(state ? { state: { ...state } } : {}) };
}

export function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) throw new RunnerProtocolError();
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

/** Exactly one frame; callers must wait for EOF before dispatching mutations. */
export class FrameReader {
  private chunks: Buffer[] = [];
  private bytes = 0;

  push(chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > MAX_FRAME_BYTES + 4) throw new RunnerProtocolError();
    this.chunks.push(chunk);
    if (this.bytes >= 4) {
      const data = Buffer.concat(this.chunks, this.bytes);
      const size = data.readUInt32BE(0);
      if (size === 0 || size > MAX_FRAME_BYTES || data.length > size + 4) throw new RunnerProtocolError();
    }
  }

  finish(): unknown {
    const data = Buffer.concat(this.chunks, this.bytes);
    if (data.length < 4 || data.readUInt32BE(0) !== data.length - 4) throw new RunnerProtocolError();
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(4))) as unknown;
    } catch { throw new RunnerProtocolError(); }
  }
}
