import { createHash } from "node:crypto";
import { AgentSdkError } from "../errors/agent-sdk-error";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base58Encode, base64, cancelledFor, CLOCK_SKEW_MS, exactWith, HEX, integerTextWith, invalidFor, matches, pinTarget,
  positive, proofHttpClient, proofNonceMessage, sha256, signWithin, solanaAddress, targetPart, TARGET_KEYS, timestampWith, UUID,
  validateProofNonce, waitFor, WSOL, type ExactFn, type RunnerProofNonce } from "./runner-proof-transport";
import { runnerPlatformWsolAccount } from "./solana-platform-account";

export type RunnerExecutionTarget = RunnerRuntimeTarget;
export interface RunnerExecutionEvidence {
  kind: "candidate_report" | "risk_report"; serverEvidenceId: string; snapshotDigest: string; staleAt: string;
}
/** Closed runner ENTRY intent (a buy; key order is the digest order). An exit (sell) is RunnerExitRequest. */
export interface RunnerExecutionRequest {
  version: 1; chain: "solana"; direction: "buy"; reservationId: string; planDigest: string; assessmentDigest: string;
  /** Signal provenance (covered by the request digest): the delivered inbox event and the source revision behind the decision. */
  eventId: string; eventDigest: string; sourceId: string; sourceRevision: number;
  /** 1-2 public evidence bindings, one per kind; `staleAt` is the original server evidence expiry, never a decision time. */
  evidence: RunnerExecutionEvidence[];
  walletAddress: string; inputMint: string; outputMint: string; grossInputAmount: string; slippageBps: number; minOutBound: string;
  maxPriorityFeeLamports: string; feeRateBps: number; feePolicyDigest: string; dailyCapLamports: string;
}
/** The owner's daily cap as a v2 buy carries it: no cap, or 1..10 SOL in canonical u64 lamports. Never a bare null. */
export type RunnerDailyCap = { kind: "none" } | { kind: "lamports"; lamports: string };
/** v2 buy (purpose balchemy.local-agent.execution.request.v2): the v1 fields in the same order, except that
 * `dailyCapLamports` is replaced by `dailyCap`. Whether "none" is accepted is decided by the backend's signed-cap gate. */
export interface RunnerExecutionRequestV2 extends Omit<RunnerExecutionRequest, "dailyCapLamports"> { dailyCap: RunnerDailyCap }
/** Any buy wire: v1 or v2 (a signal buy, told apart by its cap key), or a K1b DCA add (told apart by its `dca` key; it carries no
 * eventId/eventDigest/sourceId/sourceRevision: narrow with isRunnerDcaRequest before reading them). */
export type RunnerExecutionBuyRequest = RunnerExecutionRequest | RunnerExecutionRequestV2 | RunnerExecutionDcaRequest;
/** K1b DCA decision (key order is the digest order), covered by the request digest. parentEntryBuildDigest is the engine build
 * digest of a committed (completed) buy of the same mint on the same wallet by this agent (the opening entry or an earlier add);
 * the backend re-verifies it. ruleRevisionId (brr_ + 64 hex), rulesDigest and dcaPlanDigest are audit bindings only. */
export interface RunnerDcaPlan { parentEntryBuildDigest: string; ruleRevisionId: string; rulesDigest: string; dcaPlanDigest: string }
/** K1b DCA add (purpose balchemy.local-agent.execution.dca-request.v1): the v2 buy with its signal provenance (eventId, eventDigest,
 * sourceId, sourceRevision) replaced by `dca` in that position; every other v2 key in the same order. The backend requires the
 * owner's signed daily cap to be an amount (dca_daily_cap_required), the parent entry (dca_parent_mismatch), an open, quiet engine
 * position (position_held:<r>, dca_position_pending, dca_position_empty), record headroom (dca_record_headroom) and at most one new
 * add per agent and mint per 60 s (dca_spacing). Same nonce purpose and route as any buy. */
export interface RunnerExecutionDcaRequest {
  version: 1; chain: "solana"; direction: "buy"; reservationId: string; planDigest: string; assessmentDigest: string;
  dca: RunnerDcaPlan;
  evidence: RunnerExecutionEvidence[];
  walletAddress: string; inputMint: string; outputMint: string; grossInputAmount: string; slippageBps: number; minOutBound: string;
  maxPriorityFeeLamports: string; feeRateBps: number; feePolicyDigest: string; dailyCap: RunnerDailyCap;
}
export const RUNNER_EXIT_TRIGGERS = ["stop_loss", "take_profit", "trailing_stop", "manual"] as const;
export type RunnerExitTrigger = typeof RUNNER_EXIT_TRIGGERS[number];
/** Buy builds an exit may name as the entries that opened the position. */
export const RUNNER_EXIT_MAX_ENTRY_BUILDS = 16;
/** The fresh, server-recorded sell assessment that observed the trigger: its digest, quote.outAmount and quote.observedAtMs. */
export interface RunnerExitTriggerObservation { sellAssessmentDigest: string; observedOutLamports: string; observedAtMs: string }
/** Closed runner EXIT intent (key order is the digest order): sell grossTokenUnits of positionMint for WSOL. No signal provenance;
 * bound to the engine position, the completed buy builds that opened it and a fresh sell assessment
 * (assessmentDigest must equal triggerObservation.sellAssessmentDigest). Same nonce purpose and route as a buy. */
export interface RunnerExitRequest {
  version: 1; chain: "solana"; direction: "sell"; reservationId: string; planDigest: string; assessmentDigest: string;
  positionMint: string; grossTokenUnits: string; exitTrigger: RunnerExitTrigger; triggerObservation: RunnerExitTriggerObservation;
  /** 1-16 distinct engine build digests of this agent's committed (completed) buys of positionMint on this wallet. */
  entryBuildDigests: string[];
  walletAddress: string; slippageBps: number; minOutBound: string; maxPriorityFeeLamports: string; feeRateBps: number; feePolicyDigest: string;
}
export type RunnerExecutionIntent = RunnerExecutionBuyRequest | RunnerExitRequest;
export type RunnerExecutionExpectedTarget = RunnerExecutionTarget & { epoch: number; request: RunnerExecutionBuyRequest };
export type RunnerExitExpectedTarget = RunnerExecutionTarget & { epoch: number; request: RunnerExitRequest };
/** Either intent's pinned context (what the validators, the signer and the client accept). */
export type RunnerExecutionIntentTarget = RunnerExecutionTarget & { epoch: number; request: RunnerExecutionIntent };
export type RunnerExecutionNonce = RunnerProofNonce<"balchemy.local-agent.execution.build.v1">;
/** buy: fee_basis input_lamports (exact System transfer from the input). sell: fee_basis output_sol (Jupiter platform fee on the
 * WSOL proceeds into the platform's WSOL ATA; netIn = grossIn; feeAmount is quote-derived). */
export interface RunnerExecutionExpected {
  direction: "buy" | "sell"; wallet: string; inputMint: string; outputMint: string; inputTokenProgram: string; outputTokenProgram: string;
  tokenDecimals: number; grossIn: string; feeAmount: string; feeRateBps: number; feeRecipient: string; feeRecipientAccount: string;
  feePolicyDigest: string; netIn: string; quotedOut: string; minOut: string; slippageBps: number; maxPriorityFeeLamports: string;
  /** Fixed by direction (buy: input_lamports, sell: output_sol); validated but not part of the engine buildDigest. */
  feeBasis: "input_lamports" | "output_sol";
}
/** Unsigned v0 message facts. The runner still validates/simulates independently before any signature. */
export interface RunnerExecutionBuild {
  walletBindingId: string; unsignedMessageB64: string; messageSha256: string; blockhash: string; lastValidBlockHeight: string;
  addressLookupTables: readonly string[]; expected: Readonly<RunnerExecutionExpected>; executionAvailable: false; buildDigest: string;
  /** Sell only (absent on a buy): digest of the engine position snapshot the exit was guarded against; not in buildDigest. */
  positionDigest?: string;
  builtAt: string; expiresAt: string;
}
export interface RunnerExecutionReservation { reservationId: string; utcDay: string; amountLamports: string; dailyCapLamports: string; state: "built" }
/** A v2 buy's reservation echo: the request's own dailyCap instead of dailyCapLamports. */
export interface RunnerExecutionReservationV2 { reservationId: string; utcDay: string; amountLamports: string; dailyCap: RunnerDailyCap; state: "built" }
/** An exit reservation counts no SOL against the daily buy cap; it is an attempt record in the separate exit slots. */
export interface RunnerExitReservation { reservationId: string; utcDay: string; direction: "sell"; grossTokenUnits: string; state: "built" }
interface RunnerExecutionBase { version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string; epoch: number; completedAt: string }
export interface RunnerExecutionRefused extends RunnerExecutionBase { outcome: "refused"; reasonCode: string }
export interface RunnerExecutionBuilt extends RunnerExecutionBase {
  outcome: "built"; reservation: Readonly<RunnerExecutionReservation | RunnerExecutionReservationV2 | RunnerExitReservation>; build: Readonly<RunnerExecutionBuild>;
}
export type RunnerExecutionResponse = RunnerExecutionRefused | RunnerExecutionBuilt;
/** Runner key: sign only runnerExecutionNonceMessage after independently checking this context. Base64, 64 bytes. */
export type RunnerExecutionSigner = (nonce: Readonly<RunnerExecutionNonce>, expected: RunnerExecutionIntentTarget) => string | Promise<string>;
export interface RunnerExecutionBuildClientConfig extends RunnerExecutionTarget {
  apiBaseUrl: string; signer: RunnerExecutionSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/execution";
const PURPOSE = "balchemy.local-agent.execution.build.v1" as const;
const REQUEST_PURPOSE = "balchemy.local-agent.execution.request.v1";
const REQUEST_V2_PURPOSE = "balchemy.local-agent.execution.request.v2";
const EXIT_REQUEST_PURPOSE = "balchemy.local-agent.execution.exit-request.v1";
const DCA_REQUEST_PURPOSE = "balchemy.local-agent.execution.dca-request.v1";
const MAX_PAYLOAD_BYTES = 16 * 1024;
const DAILY_CAP_MAX = 10_000_000_000n;
const MAX_PRIORITY_FEE = 1_000_000n;
const BUILD_TTL_MS = 60_000;
const MAX_MESSAGE_BYTES = 1232 - 65;
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const RUNNER_EXECUTION_REFUSALS = ["direction_unavailable", "execution_not_armed", "runtime_heartbeat_stale", "owner_control_pending", "entries_paused", "trading_wallet_unbound", "trading_wallet_is_identity_wallet", "fee_policy_mismatch",
  "global_kill_switch_active", "chain_kill_switch_active", "provider_circuit_breaker_open", "user_trading_lock_active", "local_agent_kill_switch_active",
  "daily_cap_exceeded", "reservation_capacity_exhausted", "reservation_conflict", "reservation_in_progress", "reservation_build_expired",
  "reservation_released", "reservation_submitted", "reservation_committed", "invalid_local_swap_request", "fee_policy_unavailable",
  "fee_account_unavailable", "quote_below_min_out_bound", "local_swap_provider_unavailable", "local_swap_deadline_exceeded", "local_swap_busy",
  "local_swap_store_unavailable",
  "signal_event_mismatch", "source_authorization_changed", "source_approval_required", "evidence_stale", "evidence_mismatch",
  // S5 exits: server-side exit evidence, and the engine position guard's fixed codes.
  "exit_assessment_stale", "exit_assessment_mismatch", "exit_entry_mismatch", "position_insufficient", "position_conflict",
  "invalid_local_position_request", "local_position_unavailable", "local_position_store_unavailable",
  // M3.2 S5: a new entry needs the owner's signed first_enable approval, and its caps bound the reported ones.
  "owner_approval_missing", "owner_cap_exceeded",
  // K1b DCA adds: the parent entry, the engine position (held is position_held:<r>), record headroom, spacing and a signed daily cap.
  "dca_parent_mismatch", "dca_position_empty", "dca_position_pending", "dca_record_headroom", "dca_spacing", "dca_daily_cap_required"] as const;
const REASON = /^(?:mint_not_supported|quote_rejected|local_swap_rejected|position_held):[a-z0-9_]{1,64}$/;
const invalid: () => never = invalidFor("execution");
const cancelled = cancelledFor("execution");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);
const integer = integerTextWith(invalid);
const EVENT_ID = /^lsi_[0-9a-f]{64}$/;
const SOURCE_ID = /^src_[0-9a-f]{24}$/;
const EVIDENCE_ID = /^asset:[0-9a-f]{16}$/;
const EVIDENCE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 1-2 plain dense items, one per kind, each exactly {kind, serverEvidenceId, snapshotDigest, staleAt} (no sequence). */
function evidenceList(value: unknown): readonly RunnerExecutionEvidence[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 2
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const items = value as unknown[]; const descriptors = Object.getOwnPropertyDescriptors(items);
  const kinds = new Set<string>(); const out: RunnerExecutionEvidence[] = [];
  for (let i = 0; i < items.length; i++) {
    const field = descriptors[String(i)];
    if (!field || !("value" in field) || !field.enumerable) invalid();
    const e: unknown = field.value;
    exact(e, ["kind", "serverEvidenceId", "snapshotDigest", "staleAt"]);
    const kind = e.kind as RunnerExecutionEvidence["kind"]; const staleAt = e.staleAt as string;
    if ((kind !== "candidate_report" && kind !== "risk_report") || kinds.has(kind) || !matches(e.serverEvidenceId, EVIDENCE_ID)
      || !matches(e.snapshotDigest, HEX) || !matches(staleAt, EVIDENCE_TIME) || new Date(Date.parse(staleAt)).toISOString() !== staleAt) invalid();
    kinds.add(kind);
    out.push(Object.freeze({ kind, serverEvidenceId: e.serverEvidenceId as string, snapshotDigest: e.snapshotDigest as string, staleAt }));
  }
  return Object.freeze(out);
}

/** Plain dense array of own enumerable data elements, within [minimum, maximum] length. */
function closedArray(value: unknown, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minimum || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const items = value as unknown[]; const descriptors = Object.getOwnPropertyDescriptors(items); const out: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    const field = descriptors[String(i)];
    if (!field || !("value" in field) || !field.enumerable) invalid();
    out.push(field.value);
  }
  return out;
}

/** The own data property `key` of a plain object, or undefined (never evaluates an accessor). */
function ownValue(value: unknown, key: string): { value: unknown } | undefined {
  const field = value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key) : undefined;
  return field && "value" in field ? { value: field.value } : undefined;
}
/** Closed v2 daily cap: exactly {kind:"none"} or {kind:"lamports", lamports: 1..10 SOL}. A bare null, a missing key, an extra
 * key or an unknown kind is invalid. */
function dailyCapOf(value: unknown): Readonly<RunnerDailyCap> {
  if (ownValue(value, "kind")?.value === "none") { exact(value, ["kind"]); return Object.freeze({ kind: "none" as const }); }
  exact(value, ["kind", "lamports"]);
  if (value.kind !== "lamports") invalid();
  integer(value.lamports, 1n, DAILY_CAP_MAX);
  return Object.freeze({ kind: "lamports" as const, lamports: value.lamports as string });
}
const BUY_KEYS = ["version", "chain", "direction", "reservationId", "planDigest", "assessmentDigest", "eventId", "eventDigest",
  "sourceId", "sourceRevision", "evidence", "walletAddress", "inputMint", "outputMint",
  "grossInputAmount", "slippageBps", "minOutBound", "maxPriorityFeeLamports", "feeRateBps", "feePolicyDigest"] as const;
/** Closed buy intent: v1 (`dailyCapLamports`, exact v1 wire) or v2 (`dailyCap`), chosen by which cap key is present. A
 * buy-shaped `sell` is not an intent (an exit has its own closed key set). Key order is the digest order. */
function buyRequest(value: unknown): Readonly<RunnerExecutionBuyRequest> {
  const v2 = ownValue(value, "dailyCap") !== undefined;
  exact(value, [...BUY_KEYS, v2 ? "dailyCap" : "dailyCapLamports"]);
  const v = value;
  if (v.version !== 1 || v.chain !== "solana" || v.direction !== "buy" || !matches(v.reservationId, UUID)
    || !matches(v.planDigest, HEX) || !matches(v.assessmentDigest, HEX) || !matches(v.eventId, EVENT_ID) || !matches(v.eventDigest, HEX)
    || !matches(v.sourceId, SOURCE_ID) || !positive(v.sourceRevision) || !solanaAddress(v.walletAddress) || !solanaAddress(v.inputMint)
    || !solanaAddress(v.outputMint) || !positive(v.slippageBps) || v.slippageBps > 5000 || typeof v.feeRateBps !== "number"
    || !Number.isInteger(v.feeRateBps) || v.feeRateBps < 0 || v.feeRateBps > 10000 || !matches(v.feePolicyDigest, HEX)
    || v.inputMint !== WSOL || v.outputMint === WSOL || v.walletAddress === v.inputMint || v.walletAddress === v.outputMint) invalid();
  const gross = integer(v.grossInputAmount, 1n);
  const dailyCap = v2 ? dailyCapOf(v.dailyCap) : undefined;
  const cap = dailyCap ? (dailyCap.kind === "lamports" ? BigInt(dailyCap.lamports) : null) : integer(v.dailyCapLamports, 1n, DAILY_CAP_MAX);
  integer(v.maxPriorityFeeLamports, 0n, MAX_PRIORITY_FEE); if (v.minOutBound !== "") integer(v.minOutBound, 1n);
  const evidence = evidenceList(v.evidence);
  if (cap !== null && gross > cap) invalid();
  const common = { version: 1 as const, chain: "solana" as const, direction: "buy" as const, reservationId: v.reservationId as string,
    planDigest: v.planDigest as string, assessmentDigest: v.assessmentDigest as string, eventId: v.eventId as string,
    eventDigest: v.eventDigest as string, sourceId: v.sourceId as string, sourceRevision: v.sourceRevision as number,
    evidence: evidence as RunnerExecutionEvidence[], walletAddress: v.walletAddress as string,
    inputMint: v.inputMint as string, outputMint: v.outputMint as string, grossInputAmount: v.grossInputAmount as string, slippageBps: v.slippageBps as number,
    minOutBound: v.minOutBound as string, maxPriorityFeeLamports: v.maxPriorityFeeLamports as string, feeRateBps: v.feeRateBps as number,
    feePolicyDigest: v.feePolicyDigest as string };
  return Object.freeze(dailyCap ? { ...common, dailyCap } : { ...common, dailyCapLamports: v.dailyCapLamports as string });
}
const DCA_KEYS = ["version", "chain", "direction", "reservationId", "planDigest", "assessmentDigest", "dca", "evidence", "walletAddress",
  "inputMint", "outputMint", "grossInputAmount", "slippageBps", "minOutBound", "maxPriorityFeeLamports", "feeRateBps", "feePolicyDigest",
  "dailyCap"] as const;
const RULE_REVISION_ID = /^brr_[0-9a-f]{64}$/;
/** Closed DCA add, mirroring the backend parseDcaRequest (the v2 buy's leg, evidence, fee and cap rules). Key order is the digest order. */
function dcaRequest(value: unknown): Readonly<RunnerExecutionDcaRequest> {
  exact(value, DCA_KEYS);
  const v = value;
  const d = v.dca; exact(d, ["parentEntryBuildDigest", "ruleRevisionId", "rulesDigest", "dcaPlanDigest"]);
  if (v.version !== 1 || v.chain !== "solana" || v.direction !== "buy" || !matches(v.reservationId, UUID)
    || !matches(v.planDigest, HEX) || !matches(v.assessmentDigest, HEX) || !matches(d.parentEntryBuildDigest, HEX)
    || !matches(d.ruleRevisionId, RULE_REVISION_ID) || !matches(d.rulesDigest, HEX) || !matches(d.dcaPlanDigest, HEX)
    || !solanaAddress(v.walletAddress) || !solanaAddress(v.inputMint)
    || !solanaAddress(v.outputMint) || !positive(v.slippageBps) || v.slippageBps > 5000 || typeof v.feeRateBps !== "number"
    || !Number.isInteger(v.feeRateBps) || v.feeRateBps < 0 || v.feeRateBps > 10000 || !matches(v.feePolicyDigest, HEX)
    || v.inputMint !== WSOL || v.outputMint === WSOL || v.walletAddress === v.inputMint || v.walletAddress === v.outputMint) invalid();
  const gross = integer(v.grossInputAmount, 1n);
  const dailyCap = dailyCapOf(v.dailyCap);
  integer(v.maxPriorityFeeLamports, 0n, MAX_PRIORITY_FEE); if (v.minOutBound !== "") integer(v.minOutBound, 1n);
  const evidence = evidenceList(v.evidence);
  if (dailyCap.kind === "lamports" && gross > BigInt(dailyCap.lamports)) invalid();
  return Object.freeze({ version: 1 as const, chain: "solana" as const, direction: "buy" as const, reservationId: v.reservationId as string,
    planDigest: v.planDigest as string, assessmentDigest: v.assessmentDigest as string,
    dca: Object.freeze({ parentEntryBuildDigest: d.parentEntryBuildDigest as string, ruleRevisionId: d.ruleRevisionId as string,
      rulesDigest: d.rulesDigest as string, dcaPlanDigest: d.dcaPlanDigest as string }),
    evidence: evidence as RunnerExecutionEvidence[], walletAddress: v.walletAddress as string,
    inputMint: v.inputMint as string, outputMint: v.outputMint as string, grossInputAmount: v.grossInputAmount as string, slippageBps: v.slippageBps as number,
    minOutBound: v.minOutBound as string, maxPriorityFeeLamports: v.maxPriorityFeeLamports as string, feeRateBps: v.feeRateBps as number,
    feePolicyDigest: v.feePolicyDigest as string, dailyCap });
}
const EXIT_OBSERVED_MS = /^[1-9][0-9]{0,15}$/;
/** Closed exit (sell) intent, mirroring the backend parseExitRequest. */
function exitRequest(value: unknown): Readonly<RunnerExitRequest> {
  exact(value, ["version", "chain", "direction", "reservationId", "planDigest", "assessmentDigest", "positionMint", "grossTokenUnits",
    "exitTrigger", "triggerObservation", "entryBuildDigests", "walletAddress", "slippageBps", "minOutBound", "maxPriorityFeeLamports", "feeRateBps",
    "feePolicyDigest"]);
  const v = value;
  if (v.version !== 1 || v.chain !== "solana" || v.direction !== "sell") invalid();
  const o = v.triggerObservation; exact(o, ["sellAssessmentDigest", "observedOutLamports", "observedAtMs"]);
  const exitTrigger = RUNNER_EXIT_TRIGGERS.find((item) => item === v.exitTrigger);
  if (!matches(v.reservationId, UUID) || !matches(v.planDigest, HEX) || !matches(v.assessmentDigest, HEX) || !solanaAddress(v.positionMint)
    || !solanaAddress(v.walletAddress) || v.positionMint === WSOL || v.walletAddress === WSOL || v.walletAddress === v.positionMint
    || exitTrigger === undefined || !matches(o.sellAssessmentDigest, HEX) || !matches(o.observedAtMs, EXIT_OBSERVED_MS)
    || Number(o.observedAtMs) > Number.MAX_SAFE_INTEGER || v.assessmentDigest !== o.sellAssessmentDigest
    || !positive(v.slippageBps) || v.slippageBps > 5000 || typeof v.feeRateBps !== "number" || !Number.isInteger(v.feeRateBps)
    || v.feeRateBps < 0 || v.feeRateBps > 10000 || !matches(v.feePolicyDigest, HEX)) invalid();
  integer(o.observedOutLamports, 1n); integer(v.grossTokenUnits, 1n); integer(v.maxPriorityFeeLamports, 0n, MAX_PRIORITY_FEE);
  if (v.minOutBound !== "") integer(v.minOutBound, 1n);
  const entries = closedArray(v.entryBuildDigests, 1, RUNNER_EXIT_MAX_ENTRY_BUILDS);
  if (!entries.every((item) => matches(item, HEX)) || new Set(entries).size !== entries.length) invalid();
  return Object.freeze({ version: 1, chain: "solana", direction: "sell", reservationId: v.reservationId as string, planDigest: v.planDigest as string,
    assessmentDigest: v.assessmentDigest as string, positionMint: v.positionMint as string, grossTokenUnits: v.grossTokenUnits as string,
    exitTrigger: exitTrigger as RunnerExitTrigger, triggerObservation: Object.freeze({ sellAssessmentDigest: o.sellAssessmentDigest as string,
      observedOutLamports: o.observedOutLamports as string, observedAtMs: o.observedAtMs as string }),
    entryBuildDigests: Object.freeze(entries as string[]) as string[], walletAddress: v.walletAddress as string, slippageBps: v.slippageBps as number,
    minOutBound: v.minOutBound as string, maxPriorityFeeLamports: v.maxPriorityFeeLamports as string, feeRateBps: v.feeRateBps as number,
    feePolicyDigest: v.feePolicyDigest as string });
}
/** Closed parse of any intent; `direction` selects the closed key set (a buy keeps its exact v1 wire), and a buy with a `dca` key
 * is a DCA add. Never evaluates accessors. */
function intent(value: unknown): Readonly<RunnerExecutionIntent> {
  const direction = value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, "direction") : undefined;
  if (direction && "value" in direction && direction.value === "sell") return exitRequest(value);
  return ownValue(value, "dca") !== undefined ? dcaRequest(value) : buyRequest(value);
}
/** True for a DCA add (its closed `dca` key). */
export function isRunnerDcaRequest(value: RunnerExecutionIntent): value is RunnerExecutionDcaRequest {
  return value.direction === "buy" && "dca" in value;
}
/** The swap leg an intent asks the engine for. */
function swapLeg(r: RunnerExecutionIntent): { inputMint: string; outputMint: string; grossInputAmount: string } {
  return r.direction === "buy" ? { inputMint: r.inputMint, outputMint: r.outputMint, grossInputAmount: r.grossInputAmount }
    : { inputMint: r.positionMint, outputMint: WSOL, grossInputAmount: r.grossTokenUnits };
}
/** SHA256(UTF8(JSON.stringify([purpose, request]))): the exit purpose for an exit, the DCA purpose for a DCA add (tested before
 * the cap key: a DCA add also carries dailyCap), else the v1 or v2 buy purpose by its cap key. */
export function runnerExecutionRequestDigest(value: RunnerExecutionIntent): string {
  const parsed = intent(value);
  return sha256([parsed.direction === "sell" ? EXIT_REQUEST_PURPOSE : "dca" in parsed ? DCA_REQUEST_PURPOSE
    : "dailyCap" in parsed ? REQUEST_V2_PURPOSE : REQUEST_PURPOSE, parsed]);
}
function expected(value: RunnerExecutionIntentTarget): RunnerExecutionIntentTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, request: intent(value.request) });
}
export function validateRunnerExecutionNonce(value: unknown, expectedTarget: RunnerExecutionIntentTarget, now = Date.now()): RunnerExecutionNonce {
  const pinned = expected(expectedTarget);
  return validateProofNonce(value, pinned, PURPOSE, "execution/build", runnerExecutionRequestDigest(pinned.request), now, invalid);
}
export function runnerExecutionNonceMessage(value: RunnerExecutionNonce, expectedTarget: RunnerExecutionIntentTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerExecutionNonce(value, expectedTarget, now));
}
/** Mirrors the engine build_digest (blockchain.proto BuildLocalSolanaSwapResponse). */
export function runnerExecutionBuildDigest(b: Pick<RunnerExecutionBuild, "walletBindingId" | "unsignedMessageB64" | "messageSha256" | "blockhash"
  | "lastValidBlockHeight" | "addressLookupTables" | "expected">, requestDigest: string, req: Pick<RunnerExecutionRequest, "planDigest" | "assessmentDigest">, agentId: string): string {
  const e = b.expected;
  return sha256(["balchemy.solana-local-swap.v1", requestDigest, req.planDigest, req.assessmentDigest, agentId, b.walletBindingId,
    b.unsignedMessageB64, b.messageSha256, b.blockhash, b.lastValidBlockHeight, b.addressLookupTables,
    [e.direction, e.wallet, e.inputMint, e.outputMint, e.inputTokenProgram, e.outputTokenProgram, String(e.tokenDecimals), e.grossIn,
      e.feeAmount, String(e.feeRateBps), e.feeRecipient, e.feeRecipientAccount, e.feePolicyDigest, e.netIn, e.quotedOut, e.minOut,
      String(e.slippageBps), e.maxPriorityFeeLamports], false]);
}
function addresses(value: unknown): readonly string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 8
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); const out: string[] = [];
  for (let i = 0; i < (value as unknown[]).length; i++) {
    const field = descriptors[String(i)];
    if (!field || !("value" in field) || !field.enumerable || !solanaAddress(field.value)) invalid();
    out.push(field.value as string);
  }
  if (new Set(out).size !== out.length) invalid();
  return Object.freeze(out);
}
function compactU16(bytes: Buffer, offset: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = bytes[offset + i]; if (byte === undefined) invalid();
    value |= ((byte as number) & 0x7f) << (7 * i);
    if (((byte as number) & 0x80) === 0) return [value, offset + i + 1];
  }
  return invalid();
}
const BUILD_KEYS = ["walletBindingId", "unsignedMessageB64", "messageSha256", "blockhash", "lastValidBlockHeight", "addressLookupTables", "expected",
  "executionAvailable", "buildDigest", "builtAt", "expiresAt"] as const;
function build(value: unknown, pinned: RunnerExecutionIntentTarget, requestDigest: string, now: number): Readonly<RunnerExecutionBuild> {
  const r = pinned.request; const sell = r.direction === "sell"; const leg = swapLeg(r);
  // positionDigest: required (64 lowercase hex) on a sell; the backend omits it on a buy.
  exact(value, sell ? [...BUILD_KEYS, "positionDigest"] : BUILD_KEYS);
  if (!matches(value.walletBindingId, UUID) || value.executionAvailable !== false || !matches(value.messageSha256, HEX)
    || !matches(value.buildDigest, HEX) || !solanaAddress(value.blockhash) || typeof value.unsignedMessageB64 !== "string"
    || value.unsignedMessageB64.length > 2048 || (sell && !matches(value.positionDigest, HEX))) invalid();
  integer(value.lastValidBlockHeight, 1n);
  const message = Buffer.from(value.unsignedMessageB64 as string, "base64");
  if (message.toString("base64") !== value.unsignedMessageB64 || message.length < 4 || message.length > MAX_MESSAGE_BYTES
    || createHash("sha256").update(message).digest("hex") !== value.messageSha256) invalid();
  // v0, exactly one required signature, fee payer = the runner's own trading wallet.
  const [keys, offset] = compactU16(message, 4);
  if (message[0] !== 0x80 || message[1] !== 1 || keys < 1 || message.length < offset + 32
    || base58Encode(message.subarray(offset, offset + 32)) !== r.walletAddress) invalid();
  const tables = addresses(value.addressLookupTables);
  const e = value.expected; exact(e, ["direction", "wallet", "inputMint", "outputMint", "inputTokenProgram", "outputTokenProgram", "tokenDecimals",
    "grossIn", "feeAmount", "feeRateBps", "feeRecipient", "feeRecipientAccount", "feePolicyDigest", "netIn", "quotedOut", "minOut", "slippageBps",
    "maxPriorityFeeLamports", "feeBasis"]);
  const gross = BigInt(leg.grossInputAmount);
  if (e.direction !== r.direction || e.wallet !== r.walletAddress || e.inputMint !== leg.inputMint || e.outputMint !== leg.outputMint
    || typeof e.tokenDecimals !== "number" || !Number.isInteger(e.tokenDecimals) || e.tokenDecimals < 0 || e.tokenDecimals > 255
    || e.grossIn !== leg.grossInputAmount || e.feeRateBps !== r.feeRateBps || e.feePolicyDigest !== r.feePolicyDigest
    || e.maxPriorityFeeLamports !== r.maxPriorityFeeLamports
    || typeof e.slippageBps !== "number" || !Number.isInteger(e.slippageBps) || e.slippageBps < 1 || e.slippageBps > r.slippageBps
    || typeof e.feeRecipient !== "string" || typeof e.feeRecipientAccount !== "string"
    || (r.feeRateBps === 0 ? e.feeRecipient !== "" : !solanaAddress(e.feeRecipient) || e.feeRecipient === r.walletAddress)
    || sha256(["balchemy.solana-fee-policy.v1", "backend_global_fee_config", r.feeRateBps, e.feeRecipient]) !== r.feePolicyDigest) invalid();
  const quoted = integer(e.quotedOut, 1n); const minimum = integer(e.minOut, 1n);
  if (minimum > quoted || (r.minOutBound !== "" && minimum < BigInt(r.minOutBound))) invalid();
  if (!sell) {
    // Buy: an exact System transfer of floor(gross x bps / 10000) lamports from the input (fee_basis input_lamports).
    const fee = gross * BigInt(r.feeRateBps) / 10000n;
    if (e.feeBasis !== "input_lamports" || e.inputTokenProgram !== TOKEN_PROGRAM
      || (e.outputTokenProgram !== TOKEN_PROGRAM && e.outputTokenProgram !== TOKEN_2022_PROGRAM)
      || e.feeAmount !== fee.toString() || e.netIn !== (gross - fee).toString() || gross - fee < 1n
      || (fee === 0n ? e.feeRecipientAccount !== "" : e.feeRecipientAccount !== e.feeRecipient)) invalid();
  } else {
    // Sell: the whole gross token input is swapped (netIn = grossIn); the fee is Jupiter's platform fee on the WSOL proceeds,
    // credited to the platform's WSOL ATA (a u8: a rate above 255 bps is never built).
    const feeAmount = integer(e.feeAmount);
    if (e.feeBasis !== "output_sol" || e.outputTokenProgram !== TOKEN_PROGRAM
      || (e.inputTokenProgram !== TOKEN_PROGRAM && e.inputTokenProgram !== TOKEN_2022_PROGRAM)
      || e.netIn !== leg.grossInputAmount || r.feeRateBps > 255 || feeAmount > quoted || (r.feeRateBps === 0 && feeAmount !== 0n)
      // The engine's sell-quote bound: the platform fee is at most fee_rate_bps of the gross output, fee*10000 <= (quotedOut + fee)*bps.
      || feeAmount * 10000n > (quoted + feeAmount) * BigInt(r.feeRateBps)
      || (r.feeRateBps === 0 ? e.feeRecipientAccount !== ""
        : !solanaAddress(e.feeRecipientAccount) || e.feeRecipientAccount !== runnerPlatformWsolAccount(e.feeRecipient as string))) invalid();
  }
  const builtAt = timestamp(value.builtAt), expiresAt = timestamp(value.expiresAt);
  if (expiresAt - builtAt !== BUILD_TTL_MS || builtAt > now + CLOCK_SKEW_MS || expiresAt <= now) invalid();
  const result = Object.freeze({ ...value, addressLookupTables: tables, expected: Object.freeze({ ...e }) }) as unknown as Readonly<RunnerExecutionBuild>;
  if (runnerExecutionBuildDigest(result, requestDigest, r, pinned.agentId) !== result.buildDigest) invalid();
  return result;
}
/** Buy v1: {reservationId, utcDay, amountLamports, dailyCapLamports, state}. Buy v2: the same with `dailyCap` (the request's own,
 * closed). Exit: {reservationId, utcDay, direction: "sell", grossTokenUnits, state}. */
function reservationOf(value: unknown, r: RunnerExecutionIntent): Readonly<RunnerExecutionReservation | RunnerExecutionReservationV2 | RunnerExitReservation> {
  if (r.direction === "buy" && "dailyCap" in r) {
    exact(value, ["reservationId", "utcDay", "amountLamports", "dailyCap", "state"]);
    const echoed = dailyCapOf(value.dailyCap);
    if (value.reservationId !== r.reservationId || !matches(value.utcDay, /^\d{4}-\d{2}-\d{2}$/) || value.amountLamports !== r.grossInputAmount
      || echoed.kind !== r.dailyCap.kind || (echoed.kind === "lamports" && r.dailyCap.kind === "lamports" && echoed.lamports !== r.dailyCap.lamports)
      || value.state !== "built") invalid();
    return Object.freeze({ ...value, dailyCap: echoed }) as unknown as Readonly<RunnerExecutionReservationV2>;
  }
  if (r.direction === "buy") {
    exact(value, ["reservationId", "utcDay", "amountLamports", "dailyCapLamports", "state"]);
    if (value.reservationId !== r.reservationId || !matches(value.utcDay, /^\d{4}-\d{2}-\d{2}$/)
      || value.amountLamports !== r.grossInputAmount || value.dailyCapLamports !== r.dailyCapLamports || value.state !== "built") invalid();
    return Object.freeze({ ...value }) as unknown as Readonly<RunnerExecutionReservation>;
  }
  exact(value, ["reservationId", "utcDay", "direction", "grossTokenUnits", "state"]);
  if (value.reservationId !== r.reservationId || !matches(value.utcDay, /^\d{4}-\d{2}-\d{2}$/) || value.direction !== "sell"
    || value.grossTokenUnits !== r.grossTokenUnits || value.state !== "built") invalid();
  return Object.freeze({ ...value }) as unknown as Readonly<RunnerExitReservation>;
}
export function validateRunnerExecutionResponse(value: unknown, expectedTarget: RunnerExecutionIntentTarget, now = Date.now()): RunnerExecutionResponse {
  const pinned = expected(expectedTarget); const requestDigest = runnerExecutionRequestDigest(pinned.request);
  const base = ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "completedAt", "outcome"];
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const outcome = Object.getOwnPropertyDescriptor(value, "outcome")?.value;
  if (outcome === "refused") exact(value, [...base, "reasonCode"]);
  else if (outcome === "built") exact(value, [...base, "reservation", "build"]);
  else invalid();
  const v = value as Record<string, unknown>;
  if (!Number.isFinite(now) || v.version !== 1 || v.requestDigest !== requestDigest || v.agentId !== pinned.agentId
    || v.bindingDigest !== pinned.bindingDigest || v.instanceId !== pinned.instanceId || v.epoch !== pinned.epoch
    || Math.abs(timestamp(v.completedAt) - now) > CLOCK_SKEW_MS) invalid();
  let result: RunnerExecutionResponse;
  if (outcome === "refused") {
    if (typeof v.reasonCode !== "string" || !(RUNNER_EXECUTION_REFUSALS.includes(v.reasonCode as typeof RUNNER_EXECUTION_REFUSALS[number]) || REASON.test(v.reasonCode))) invalid();
    result = Object.freeze({ ...v }) as unknown as RunnerExecutionRefused;
  } else {
    result = Object.freeze({ ...v, reservation: reservationOf(v.reservation, pinned.request), build: build(v.build, pinned, requestDigest, now) }) as unknown as RunnerExecutionBuilt;
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return result;
}

export class RunnerExecutionBuildClient {
  private readonly pinned: RunnerExecutionTarget;
  private readonly signer: RunnerExecutionSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerExecutionBuildClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }
  /** A single bounded attempt. Retrying with the same reservationId returns the same reservation and unsigned message. */
  async build(input: RunnerExecutionIntent, epoch: number, callerSignal?: AbortSignal): Promise<RunnerExecutionResponse> {
    const operation = expected({ ...this.pinned, epoch, request: input });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, this.transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerExecutionRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:execution-nonce" }), scope.signal, cancelled);
      const nonce = validateRunnerExecutionNonce(data, operation);
      const signature = await signWithin(() => this.signer(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      validateRunnerExecutionNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/build`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        request: operation.request }, { kind: "side_effecting", operation: "local-agent:execution-build" }), scope.signal, cancelled);
      return validateRunnerExecutionResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
