/** Local signal receipts and language decisions. No execution authority or credentials. */
import { createHash } from "node:crypto";
import { validateRunnerSignal, runnerAssessmentRequestDigest, type RunnerSignal, type RunnerAssessmentRequest,
  type RunnerAssessmentResponse } from "@balchemyai/agent-sdk";
import { parsePrivateSignalCallReservation, privateSignalAdmissionDigest, type PrivateSignalCallReservation } from "./private-autonomy.js";
import { parsePrivateSignalPlan, type PrivateSignalPlan } from "./private-signal-plan.js";
import { isId, isTimestamp } from "./protocol.js";
import { PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS } from "./private-sizing.js";
import { parsePrivateOuterDecision, privateOuterSignalDigest, type PrivateOuterDecision,
  type PrivateOuterHoldReason, type PrivateOuterPrefilterBinding, type PrivateOuterEvidenceBinding } from "./private-outer-decision.js";

export interface PrivateSignalReceiptInput {
  localProfileId: string;
  /** Local alias; serverAgentId is the adopted server identity. */
  agentId: string;
  frontendOrigin: string;
  serverAgentId: string;
  bindingDigest: string;
  instanceId: string;
  epoch: number;
  receivedAt: string;
  signal: RunnerSignal;
}
export interface PrivateSignalStart {
  modelRevision: number;
  runtimeVersion: number;
  ruleRevisionId: `brr_${string}`;
  conversationId: string;
  /** Paired fields distinguish current plan-aware work from immutable legacy records. */
  planVersion?: 1;
  sizingPolicyDigest?: string | null;
}
export interface PrivateSignalResult {
  decision: PrivateOuterDecision;
  admission: PrivateOuterPrefilterBinding;
  plan?: PrivateSignalPlan;
  /** Read-only evidence for a resolved plan only. It never changes the plan or authorizes execution. */
  assessment?: PrivateSignalAssessment;
}
/** Wrapped SOL; the backend's fixed assessment input mint. */
export const PRIVATE_ASSESSMENT_INPUT_MINT = "So11111111111111111111111111111111111111112";
/** New local sizing allows at most this (a size stored earlier may hold up to 10000 bps); the public assessment accepts at most
 * this. Never clamped. The shared execution
 * bound (private-sizing.ts), so the position ledger and the assessment can never disagree. */
export const PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS = PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS;
/** Compact closed projection (no transport envelope, identity or request echo); the full SDK response
 * would not fit beside a 4 KiB plan. Worst case (u64 amounts, 44-char recipient, longest consistent
 * reason set) is ~1.2 KiB. MAX_PRIVATE_SIGNAL_JOB_BYTES is unchanged: a job that still cannot hold the
 * record degrades to an explicit "record_unrepresentable" failure, never a larger limit or a lost decision. */
export const MAX_PRIVATE_SIGNAL_ASSESSMENT_BYTES = 1536;
export const PRIVATE_ASSESSMENT_PRETRADE_REASONS = ["signal_unavailable:rugcheck", "signal_unavailable:helius", "rugcheck_risks_present",
  "mint_authority_present", "freeze_authority_present", "high_risk_combined"] as const;
export type PrivateAssessmentPretradeReason = typeof PRIVATE_ASSESSMENT_PRETRADE_REASONS[number];
export type PrivateAssessmentNotRequestedReason = "slippage_above_assessment_bound" | "output_is_input_mint" | "request_unrepresentable";
/** deadline_insufficient: the signal/source freshness window left too little time, so no backend call was made. */
export const PRIVATE_ASSESSMENT_FAILURE_REASONS = ["transport_unavailable", "invalid_response", "record_unrepresentable", "deadline_insufficient"] as const;
export type PrivateAssessmentFailureReason = typeof PRIVATE_ASSESSMENT_FAILURE_REASONS[number];
export type PrivateAssessmentUnavailableReason = "deadline_exceeded" | "quote_unavailable" | "pretrade_unavailable";
export interface PrivateSignalAssessmentEvidence {
  version: 1; outcome: "complete" | "unavailable"; reason: "" | PrivateAssessmentUnavailableReason;
  requestDigest: string; planDigest: string; receivedAt: string; startedAtMs: string; completedAtMs: string; expiresAtMs: string;
  fee: { rateBps: number; recipient: string; feeLamports: string; netInputLamports: string; policyDigest: string };
  quote: { outAmount: string; minOut: string; contextSlot: string; observedAtMs: string } | null;
  pretrade: { verdict: "allow" | "require_approval" | "block"; reasons: PrivateAssessmentPretradeReason[];
    rugcheckStatus: "available" | "unavailable"; rugcheckObservedAtMs: string;
    mintStatus: "available" | "unavailable"; mintObservedAtMs: string; mintContextSlot: string } | null;
  assessmentDigest: string; executionAvailable: false;
}
export interface PrivateSignalAssessmentFailure {
  version: 1; outcome: "failed"; reason: PrivateAssessmentFailureReason; requestDigest: string; planDigest: string;
  failedAt: string; executionAvailable: false;
}
export interface PrivateSignalAssessmentNotRequested {
  version: 1; outcome: "not_requested"; reason: PrivateAssessmentNotRequestedReason; planDigest: string; executionAvailable: false;
}
export type PrivateSignalAssessment = PrivateSignalAssessmentEvidence | PrivateSignalAssessmentFailure | PrivateSignalAssessmentNotRequested;
export const PRIVATE_SIGNAL_HOLD_REASONS = [
  "scope_mismatch", "runtime_changed", "runtime_disallowed", "signal_future", "signal_stale",
  "rules_changed", "rules_missing", "rules_held", "rules_invalid", "evidence_unresolved", "evidence_missing",
  "evidence_held", "evidence_mismatch", "entry_facts_missing", "entry_signals_missing", "entry_rule_failed",
  "strategy_facts_missing", "model_locked", "source_stale", "lease_unavailable", "admission_unavailable",
  "daily_call_limit", "token_cooldown", "legacy_usage_unknown", "clock_rollback", "call_allowance_unavailable", "sizing_policy_changed",
  "model_budget_exhausted",
  // K4: a launchpad signal whose launchpad this agent is not subscribed to, is not live in the catalog, or whose catalog or
  // subscription could not be read (private-launchpads.ts). Only launchpad jobs carry it.
  "launchpad_unavailable",
] as const satisfies readonly (PrivateOuterHoldReason | "model_locked" | "source_stale" | "lease_unavailable" | "admission_unavailable"
  | "daily_call_limit" | "token_cooldown" | "legacy_usage_unknown" | "clock_rollback" | "call_allowance_unavailable" | "sizing_policy_changed"
  | "model_budget_exhausted" | "launchpad_unavailable")[];
export type PrivateSignalHoldReason = typeof PRIVATE_SIGNAL_HOLD_REASONS[number];
export type PrivateSignalFailure = "provider_unavailable" | "research_unavailable" | "invalid_result";
export type PrivateSignalJobState = "received" | "running" | "completed" | "held" | "failed" | "cancelled" | "interrupted";
export interface PrivateSignalJob {
  kind: "signal_decision";
  jobId: string;
  agentId: string;
  originalInstanceId: string;
  generation: number;
  state: PrivateSignalJobState;
  createdAt: number;
  updatedAt: number;
  receipt: PrivateSignalReceiptInput;
  start?: PrivateSignalStart;
  callReservation?: PrivateSignalCallReservation;
  result?: PrivateSignalResult;
  reason?: PrivateSignalHoldReason;
  error?: PrivateSignalFailure;
}
export const MAX_PRIVATE_SIGNAL_JOB_BYTES = 8 * 1024;
const HASH = /^sha256:[a-f0-9]{64}$/;
const HEX = /^[a-f0-9]{64}$/;
const REVISION = /^brr_[a-f0-9]{64}$/;

export class PrivateSignalJobError extends Error {
  constructor() { super("Invalid private signal job"); this.name = "PrivateSignalJobError"; }
}
function invalid(): never { throw new PrivateSignalJobError(); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(descriptors).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function iso(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

export function parsePrivateSignalReceipt(value: unknown): PrivateSignalReceiptInput {
  exact(value, ["localProfileId", "agentId", "frontendOrigin", "serverAgentId", "bindingDigest", "instanceId", "epoch", "receivedAt", "signal"]);
  if (!isId(value.localProfileId) || !isId(value.agentId) || !isId(value.instanceId)
    || !positive(value.epoch) || !iso(value.receivedAt) || typeof value.frontendOrigin !== "string"
    || value.frontendOrigin.length > 2048 || typeof value.serverAgentId !== "string" || typeof value.bindingDigest !== "string") invalid();
  try {
    const url = new URL(value.frontendOrigin);
    if (url.origin !== value.frontendOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
    const signal = validateRunnerSignal(value.signal, { agentId: value.serverAgentId, bindingDigest: value.bindingDigest }, value.receivedAt);
    return freeze({ localProfileId: value.localProfileId, agentId: value.agentId, frontendOrigin: value.frontendOrigin,
      serverAgentId: value.serverAgentId, bindingDigest: value.bindingDigest, instanceId: value.instanceId,
      epoch: value.epoch, receivedAt: value.receivedAt, signal: { ...signal } });
  } catch { return invalid(); }
}
export const validatePrivateSignalReceipt = parsePrivateSignalReceipt;

/** Stable across lease/daemon replacement, but never across local or adopted identity. */
export function privateSignalJobId(input: PrivateSignalReceiptInput): string {
  const receipt = parsePrivateSignalReceipt(input);
  return `signal_${createHash("sha256").update(JSON.stringify(["balchemy.private-signal-job.v1", receipt.localProfileId,
    receipt.agentId, receipt.serverAgentId, receipt.bindingDigest, receipt.signal.eventId])).digest("hex")}`;
}
/** Binds the original acquisition too; a replay keeps these original bytes. */
export function privateSignalReceiptDigest(input: PrivateSignalReceiptInput): string {
  return createHash("sha256").update(JSON.stringify(["balchemy.private-signal-receipt.v1", parsePrivateSignalReceipt(input)])).digest("hex");
}
export function parsePrivateSignalStart(value: unknown): PrivateSignalStart {
  exact(value, ["modelRevision", "runtimeVersion", "ruleRevisionId", "conversationId"], ["planVersion", "sizingPolicyDigest"]);
  if (Object.hasOwn(value, "planVersion") || Object.hasOwn(value, "sizingPolicyDigest")) {
    if (value.planVersion !== 1 || !Object.hasOwn(value, "sizingPolicyDigest")
      || (value.sizingPolicyDigest !== null && (typeof value.sizingPolicyDigest !== "string" || !HASH.test(value.sizingPolicyDigest)))) invalid();
  }
  if (!positive(value.modelRevision) || !positive(value.runtimeVersion) || !isId(value.conversationId)
    || typeof value.ruleRevisionId !== "string" || !REVISION.test(value.ruleRevisionId)) invalid();
  return freeze({ modelRevision: value.modelRevision, runtimeVersion: value.runtimeVersion,
    ruleRevisionId: value.ruleRevisionId as `brr_${string}`, conversationId: value.conversationId,
    ...(value.planVersion === 1 ? { planVersion: 1 as const, sizingPolicyDigest: value.sizingPolicyDigest as string | null } : {}) });
}
export function parsePrivateSignalResult(value: unknown, receipt: PrivateSignalReceiptInput, start: PrivateSignalStart): PrivateSignalResult {
  receipt = parsePrivateSignalReceipt(receipt); start = parsePrivateSignalStart(start);
  exact(value, ["decision", "admission"], ["plan", "assessment"]); exact(value.decision, ["action", "refId"]);
  const refId = `asset:${receipt.signal.chain}:${receipt.signal.assetId}`;
  let decision: PrivateOuterDecision;
  try { decision = parsePrivateOuterDecision(JSON.stringify(value.decision), refId); } catch { return invalid(); }
  const admission = parsePrivateSignalAdmission(value.admission, receipt, start);
  if ((start.planVersion === 1) !== Object.hasOwn(value, "plan")) invalid();
  const plan = start.planVersion === 1 ? parsePrivateSignalPlan(value.plan,
    { receipt, start, decision, admission, jobId: privateSignalJobId(receipt) }) : undefined;
  // Legacy results carry no assessment; one exists only beside a resolved plan.
  if (Object.hasOwn(value, "assessment") && plan?.state !== "resolved") invalid();
  const assessment = plan && Object.hasOwn(value, "assessment") ? parsePrivateSignalAssessment(value.assessment, plan) : undefined;
  return freeze({ decision, admission, ...(plan ? { plan } : {}), ...(assessment ? { assessment } : {}) });
}

const U64_MAX = (1n << 64n) - 1n;
function sha256(value: readonly unknown[]): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
function u64(value: unknown, nonzero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) invalid();
  const result = BigInt(value); if (result > U64_MAX || (nonzero && result === 0n)) invalid(); return result;
}
/** Historical milliseconds stay renderable; they are never compared with the current time. */
function millis(value: unknown): bigint {
  const result = u64(value, true); if (result > BigInt(Number.MAX_SAFE_INTEGER)) invalid(); return result;
}
function solanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let integer = 0n; for (const character of value) integer = integer * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0; for (let remaining = integer; remaining > 0n; remaining >>= 8n) bytes++;
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
/** The plan facts a buy assessment and its swap expectation read (K1b DCA: a DCA add supplies these from its own durable plan record,
 * never a forged signal plan). */
export type PrivateBuyPlanFacts = Pick<PrivateSignalPlan, "state" | "asset" | "amount" | "slippageBps" | "digest">;
/** Plan digests carry a "sha256:" prefix; the public assessment binds bare hex. */
function planHex(plan: PrivateBuyPlanFacts): string {
  const hex = plan.digest.slice("sha256:".length); if (!plan.digest.startsWith("sha256:") || !HEX.test(hex)) invalid(); return hex;
}
/** Frozen v1 of the SDK's request digest and closed request checks (purpose, key order, canonical JSON). Reopening historical
 * records uses this copy so a later SDK tightening cannot make a saved store unparseable; the live path keeps the SDK function. */
export function privateAssessmentRequestDigestV1(value: RunnerAssessmentRequest): string {
  exact(value, ["version", "chain", "inputMint", "outputMint", "grossInputLamports", "slippageBps", "planDigest"]);
  if (value.version !== 1 || value.chain !== "solana" || value.inputMint !== PRIVATE_ASSESSMENT_INPUT_MINT
    || !solanaAddress(value.outputMint) || value.outputMint === PRIVATE_ASSESSMENT_INPUT_MINT
    || !positive(value.slippageBps) || value.slippageBps > PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS
    || typeof value.planDigest !== "string" || !HEX.test(value.planDigest)) invalid();
  u64(value.grossInputLamports, true);
  return createHash("sha256").update(JSON.stringify(["balchemy.local-agent.assessment.request.v1", { version: 1, chain: "solana",
    inputMint: PRIVATE_ASSESSMENT_INPUT_MINT, outputMint: value.outputMint, grossInputLamports: value.grossInputLamports,
    slippageBps: value.slippageBps, planDigest: value.planDigest }]), "utf8").digest("hex");
}
export type DerivedAssessmentRequest = { request: RunnerAssessmentRequest; requestDigest: string } | { reason: PrivateAssessmentNotRequestedReason };
function deriveAssessmentRequest(plan: PrivateBuyPlanFacts, digest: (request: RunnerAssessmentRequest) => string): DerivedAssessmentRequest {
  if (plan.state !== "resolved" || plan.asset.chain !== "solana" || !plan.amount || plan.slippageBps === null) invalid();
  if (plan.slippageBps > PRIVATE_ASSESSMENT_MAX_SLIPPAGE_BPS) return freeze({ reason: "slippage_above_assessment_bound" as const });
  if (plan.asset.assetId === PRIVATE_ASSESSMENT_INPUT_MINT) return freeze({ reason: "output_is_input_mint" as const });
  const request: RunnerAssessmentRequest = { version: 1, chain: "solana", inputMint: PRIVATE_ASSESSMENT_INPUT_MINT,
    outputMint: plan.asset.assetId, grossInputLamports: plan.amount.amountBaseUnits, slippageBps: plan.slippageBps, planDigest: planHex(plan) };
  let requestDigest: string;
  try { requestDigest = digest(request); } catch { return freeze({ reason: "request_unrepresentable" as const }); }
  return freeze({ request, requestDigest });
}
/** The only request a saved plan may produce (live path, SDK digest). Boundary mismatches are explicit outcomes, never clamped. */
export function privateSignalAssessmentRequest(plan: PrivateBuyPlanFacts): DerivedAssessmentRequest {
  return deriveAssessmentRequest(plan, runnerAssessmentRequestDigest);
}
/** Historical derivation for saved records: frozen v1 digest, independent of the installed SDK's current strictness. */
function resolvedRequest(plan: PrivateBuyPlanFacts): { request: RunnerAssessmentRequest; requestDigest: string } {
  const derived = deriveAssessmentRequest(plan, privateAssessmentRequestDigestV1); if ("reason" in derived) invalid(); return derived;
}
export function privateSignalAssessmentNotRequested(plan: PrivateSignalPlan, reason: PrivateAssessmentNotRequestedReason): PrivateSignalAssessmentNotRequested {
  return parsePrivateSignalAssessment({ version: 1, outcome: "not_requested", reason, planDigest: planHex(plan),
    executionAvailable: false }, plan) as PrivateSignalAssessmentNotRequested;
}
export function privateSignalAssessmentFailure(plan: PrivateSignalPlan, reason: PrivateAssessmentFailureReason, failedAt: string): PrivateSignalAssessmentFailure {
  return parsePrivateSignalAssessment({ version: 1, outcome: "failed", reason, planDigest: planHex(plan),
    executionAvailable: false, requestDigest: resolvedRequest(plan).requestDigest, failedAt }, plan) as PrivateSignalAssessmentFailure;
}
/** Projects an SDK-validated response. Dropped fields are request echoes, checked here and bound by the digest. */
export function privateSignalAssessmentEvidence(plan: PrivateBuyPlanFacts, response: RunnerAssessmentResponse, receivedAt: string): PrivateSignalAssessmentEvidence {
  const { request, requestDigest } = resolvedRequest(plan); const a = response.assessment;
  if (response.requestDigest !== requestDigest || a.requestDigest !== requestDigest || a.planDigest !== request.planDigest
    || a.inputMint !== request.inputMint || a.outputMint !== request.outputMint || a.grossInputLamports !== request.grossInputLamports
    || a.slippageBps !== request.slippageBps || a.executionAvailable !== false || a.fee.source !== "backend_global_fee_config"
    || a.fee.grossInputLamports !== request.grossInputLamports
    || (a.quote !== undefined && (a.quote.inputMint !== request.inputMint || a.quote.outputMint !== request.outputMint
      || a.quote.inAmount !== a.fee.netInputLamports || a.quote.slippageBps !== request.slippageBps))) invalid();
  return parsePrivateSignalAssessment({ version: 1, outcome: a.status, reason: a.reasonCode, planDigest: a.planDigest,
    executionAvailable: false, requestDigest, receivedAt, startedAtMs: a.startedAtMs, completedAtMs: a.completedAtMs, expiresAtMs: a.expiresAtMs,
    fee: { rateBps: a.fee.rateBps, recipient: a.fee.recipient, feeLamports: a.fee.feeLamports, netInputLamports: a.fee.netInputLamports,
      policyDigest: a.fee.policyDigest },
    quote: a.quote ? { outAmount: a.quote.outAmount, minOut: a.quote.minOut, contextSlot: a.quote.contextSlot, observedAtMs: a.quote.observedAtMs } : null,
    pretrade: a.pretrade ? { verdict: a.pretrade.verdict, reasons: [...a.pretrade.reasons], rugcheckStatus: a.pretrade.rugcheckStatus,
      rugcheckObservedAtMs: a.pretrade.rugcheckObservedAtMs, mintStatus: a.pretrade.mintStatus, mintObservedAtMs: a.pretrade.mintObservedAtMs,
      mintContextSlot: a.pretrade.mintContextSlot } : null,
    assessmentDigest: a.assessmentDigest }, plan) as PrivateSignalAssessmentEvidence;
}
function pretradeReasons(value: unknown): PrivateAssessmentPretradeReason[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > PRIVATE_ASSESSMENT_PRETRADE_REASONS.length
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value); let previous = -1; const reasons: PrivateAssessmentPretradeReason[] = [];
  for (let index = 0; index < value.length; index++) {
    const field = descriptors[String(index)]; if (!field || !("value" in field) || !field.enumerable) invalid();
    // Canonical SDK order; also rejects unknown and duplicate reasons.
    const position = PRIVATE_ASSESSMENT_PRETRADE_REASONS.indexOf(field.value as PrivateAssessmentPretradeReason);
    if (position <= previous) invalid(); previous = position; reasons.push(PRIVATE_ASSESSMENT_PRETRADE_REASONS[position]!);
  }
  return reasons;
}
/** Time-independent replica of the SDK's closed checks plus its exact assessment digest. */
function assessmentEvidence(value: Record<string, unknown>, request: RunnerAssessmentRequest, requestDigest: string): PrivateSignalAssessmentEvidence {
  if (!iso(value.receivedAt) || typeof value.assessmentDigest !== "string" || !HEX.test(value.assessmentDigest)) invalid();
  const start = millis(value.startedAtMs), end = millis(value.completedAtMs), expiry = millis(value.expiresAtMs);
  if (end < start || expiry !== start + 15000n || end >= expiry
    || BigInt(Date.parse(value.receivedAt)) + 5000n < end || BigInt(Date.parse(value.receivedAt)) > expiry + 5000n) invalid();
  exact(value.fee, ["rateBps", "recipient", "feeLamports", "netInputLamports", "policyDigest"]); const fee = value.fee;
  if (typeof fee.rateBps !== "number" || !Number.isInteger(fee.rateBps) || fee.rateBps < 0 || fee.rateBps > 10000
    || (fee.rateBps === 0 ? fee.recipient !== "" : !solanaAddress(fee.recipient))
    || fee.policyDigest !== sha256(["balchemy.solana-fee-policy.v1", "backend_global_fee_config", fee.rateBps, fee.recipient])) invalid();
  const rateBps = fee.rateBps as number; const gross = BigInt(request.grossInputLamports);
  const cost = u64(fee.feeLamports), net = u64(fee.netInputLamports, true);
  if (cost !== gross * BigInt(rateBps) / 10000n || cost + net !== gross) invalid();
  let quote: PrivateSignalAssessmentEvidence["quote"] = null;
  if (value.quote !== null) {
    exact(value.quote, ["outAmount", "minOut", "contextSlot", "observedAtMs"]); const q = value.quote;
    const out = u64(q.outAmount, true), minimum = u64(q.minOut, true); u64(q.contextSlot, true); const observed = millis(q.observedAtMs);
    if (minimum !== out * BigInt(10000 - request.slippageBps) / 10000n || observed < start || observed > end) invalid();
    quote = { outAmount: q.outAmount as string, minOut: q.minOut as string, contextSlot: q.contextSlot as string, observedAtMs: q.observedAtMs as string };
  }
  let pretrade: PrivateSignalAssessmentEvidence["pretrade"] = null;
  if (value.pretrade !== null) {
    exact(value.pretrade, ["verdict", "reasons", "rugcheckStatus", "rugcheckObservedAtMs", "mintStatus", "mintObservedAtMs", "mintContextSlot"]);
    const p = value.pretrade; const reasons = pretradeReasons(p.reasons);
    const has = (reason: PrivateAssessmentPretradeReason): boolean => reasons.includes(reason);
    const rugMissing = has("signal_unavailable:rugcheck"), mintMissing = has("signal_unavailable:helius");
    const rugRisk = has("rugcheck_risks_present"), mintRisk = has("mint_authority_present");
    if (p.rugcheckStatus !== (rugMissing ? "unavailable" : "available") || p.mintStatus !== (mintMissing ? "unavailable" : "available")
      || (rugMissing && rugRisk) || (mintMissing && (mintRisk || has("freeze_authority_present")))
      || has("high_risk_combined") !== (rugRisk && mintRisk)
      || p.verdict !== (rugRisk && mintRisk ? "block" : reasons.length > 0 ? "require_approval" : "allow")) invalid();
    for (const time of [millis(p.rugcheckObservedAtMs), millis(p.mintObservedAtMs)]) if (time < start || time > end) invalid();
    if (mintMissing) { if (p.mintContextSlot !== "") invalid(); } else u64(p.mintContextSlot, true);
    pretrade = { verdict: p.verdict as "allow" | "require_approval" | "block", reasons,
      rugcheckStatus: p.rugcheckStatus as "available" | "unavailable", rugcheckObservedAtMs: p.rugcheckObservedAtMs as string,
      mintStatus: p.mintStatus as "available" | "unavailable", mintObservedAtMs: p.mintObservedAtMs as string, mintContextSlot: p.mintContextSlot as string };
  }
  const span = end - start;
  const complete = quote !== null && pretrade?.rugcheckStatus === "available" && pretrade.mintStatus === "available";
  if (value.outcome === "complete") { if (!complete || value.reason !== "" || span > 12000n) invalid(); }
  else if (value.outcome !== "unavailable") invalid();
  else if (value.reason === "deadline_exceeded") { if (quote !== null || pretrade !== null || span < 12000n) invalid(); }
  else if (value.reason === "quote_unavailable") { if (quote !== null || span > 12000n) invalid(); }
  else if (value.reason === "pretrade_unavailable") { if (quote === null || complete || span > 12000n) invalid(); }
  else invalid();
  const recipient = fee.recipient as string, feeLamports = fee.feeLamports as string, netInputLamports = fee.netInputLamports as string;
  const policyDigest = fee.policyDigest as string;
  const digest = sha256(["balchemy.solana-assessment.v1", requestDigest, request.planDigest, request.inputMint, request.outputMint,
    request.grossInputLamports, request.slippageBps, value.startedAtMs, value.completedAtMs, value.expiresAtMs, value.outcome, value.reason,
    ["backend_global_fee_config", rateBps, recipient, request.grossInputLamports, feeLamports, netInputLamports, policyDigest],
    quote ? [request.inputMint, request.outputMint, netInputLamports, quote.outAmount, quote.minOut, request.slippageBps, quote.contextSlot, quote.observedAtMs] : null,
    pretrade ? [pretrade.verdict, pretrade.reasons, pretrade.rugcheckStatus, pretrade.rugcheckObservedAtMs, pretrade.mintStatus,
      pretrade.mintObservedAtMs, pretrade.mintContextSlot] : null, false]);
  if (value.assessmentDigest !== digest) invalid();
  return { version: 1, outcome: value.outcome as "complete" | "unavailable", reason: value.reason as PrivateSignalAssessmentEvidence["reason"], requestDigest,
    planDigest: request.planDigest, receivedAt: value.receivedAt as string, startedAtMs: value.startedAtMs as string, completedAtMs: value.completedAtMs as string,
    expiresAtMs: value.expiresAtMs as string, fee: { rateBps, recipient, feeLamports, netInputLamports, policyDigest }, quote, pretrade,
    assessmentDigest: digest, executionAvailable: false };
}
const ASSESSMENT_BASE = ["version", "outcome", "reason", "planDigest", "executionAvailable"];
/** Strict historical reopen bound to the exact plan; no current-time freshness is applied. */
export function parsePrivateSignalAssessment(value: unknown, plan: PrivateBuyPlanFacts): PrivateSignalAssessment {
  exact(value, ASSESSMENT_BASE, ["requestDigest", "failedAt", "receivedAt", "startedAtMs", "completedAtMs", "expiresAtMs",
    "fee", "quote", "pretrade", "assessmentDigest"]);
  const derived = deriveAssessmentRequest(plan, privateAssessmentRequestDigestV1); const planDigest = planHex(plan);
  if (value.version !== 1 || value.planDigest !== planDigest || value.executionAvailable !== false) invalid();
  let result: PrivateSignalAssessment;
  if (value.outcome === "not_requested") {
    exact(value, ASSESSMENT_BASE);
    // A live SDK that later tightens may refuse a request the frozen v1 accepts; that record must still reopen.
    const reason = "reason" in derived ? derived.reason : "request_unrepresentable" as const;
    if (value.reason !== reason) invalid();
    result = { version: 1, outcome: "not_requested", reason, planDigest, executionAvailable: false };
  } else {
    if ("reason" in derived || value.requestDigest !== derived.requestDigest) invalid();
    if (value.outcome === "failed") {
      exact(value, [...ASSESSMENT_BASE, "requestDigest", "failedAt"]);
      if (!(PRIVATE_ASSESSMENT_FAILURE_REASONS as readonly string[]).includes(String(value.reason)) || !iso(value.failedAt)) invalid();
      result = { version: 1, outcome: "failed", reason: value.reason as PrivateAssessmentFailureReason, requestDigest: derived.requestDigest,
        planDigest, failedAt: value.failedAt as string, executionAvailable: false };
    } else if (value.outcome === "complete" || value.outcome === "unavailable") {
      exact(value, [...ASSESSMENT_BASE, "requestDigest", "receivedAt", "startedAtMs", "completedAtMs", "expiresAtMs", "fee", "quote", "pretrade", "assessmentDigest"]);
      result = assessmentEvidence(value, derived.request, derived.requestDigest);
    } else invalid();
  }
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PRIVATE_SIGNAL_ASSESSMENT_BYTES) invalid();
  return freeze(result);
}
export function parsePrivateSignalAdmission(value: unknown, receipt: PrivateSignalReceiptInput, start: PrivateSignalStart): PrivateOuterPrefilterBinding {
  receipt = parsePrivateSignalReceipt(receipt); start = parsePrivateSignalStart(start);
  const refId = `asset:${receipt.signal.chain}:${receipt.signal.assetId}`;
  const a = value;
  exact(a, ["signalId", "signalDigest", "source", "chain", "assetId", "refId", "runtimeVersion", "revisionId",
    "sourceDigest", "rulesDigest", "compiledDigest", "evidence"]);
  exact(a.source, ["platform", "sourceId"]);
  const source = { platform: receipt.signal.platform, sourceId: receipt.signal.sourceId };
  const signalDigest = privateOuterSignalDigest({ localProfileId: receipt.localProfileId, agentId: receipt.agentId,
    conversationId: start.conversationId }, { signalId: receipt.signal.eventId, chain: receipt.signal.chain,
    assetId: receipt.signal.assetId, refId, observedAt: receipt.signal.observedAt, source });
  if (a.signalId !== receipt.signal.eventId || a.signalDigest !== signalDigest || a.chain !== receipt.signal.chain
    || a.assetId !== receipt.signal.assetId || a.refId !== refId || a.source.platform !== source.platform || a.source.sourceId !== source.sourceId
    || a.runtimeVersion !== start.runtimeVersion || a.revisionId !== start.ruleRevisionId
    || [a.sourceDigest, a.rulesDigest, a.compiledDigest].some((item) => typeof item !== "string" || !HASH.test(item))
    || !Array.isArray(a.evidence) || Object.getPrototypeOf(a.evidence) !== Array.prototype || a.evidence.length < 1 || a.evidence.length > 2) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(a.evidence);
  if (Reflect.ownKeys(a.evidence).length !== a.evidence.length + 1 || Object.keys(a.evidence).length !== a.evidence.length
    || Object.values(descriptors).some((field) => !("value" in field))) invalid();
  const kinds = new Set<string>();
  const evidence = a.evidence.map((entry: unknown): PrivateOuterEvidenceBinding => {
    exact(entry, ["kind", "sequence", "snapshotDigest", "serverEvidenceId", "staleAt"]);
    if ((entry.kind !== "candidate_report" && entry.kind !== "risk_report") || kinds.has(entry.kind)
      || !positive(entry.sequence) || typeof entry.snapshotDigest !== "string" || !HEX.test(entry.snapshotDigest)
      || typeof entry.serverEvidenceId !== "string" || !/^asset:[0-9a-f]{16}$/.test(entry.serverEvidenceId) || !iso(entry.staleAt)) invalid();
    kinds.add(entry.kind);
    return { kind: entry.kind, sequence: entry.sequence, snapshotDigest: entry.snapshotDigest,
      serverEvidenceId: entry.serverEvidenceId, staleAt: entry.staleAt };
  });
  return freeze({ signalId: receipt.signal.eventId, signalDigest, source, chain: receipt.signal.chain,
    assetId: receipt.signal.assetId, refId, runtimeVersion: start.runtimeVersion, revisionId: start.ruleRevisionId,
    sourceDigest: a.sourceDigest as string, rulesDigest: a.rulesDigest as string, compiledDigest: a.compiledDigest as string, evidence });
}

/** Reopening validates historical shape/bindings, not current-time freshness. */
export function parsePrivateSignalJob(value: unknown): PrivateSignalJob {
  exact(value, ["kind", "jobId", "agentId", "originalInstanceId", "generation", "state", "createdAt", "updatedAt", "receipt"],
    ["start", "result", "reason", "error", "callReservation"]);
  const receipt = parsePrivateSignalReceipt(value.receipt);
  if (value.kind !== "signal_decision" || value.jobId !== privateSignalJobId(receipt) || value.agentId !== receipt.agentId
    || value.originalInstanceId !== receipt.instanceId || !positive(value.generation) || value.generation > 3
    || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt
    || typeof value.state !== "string" || !["received", "running", "completed", "held", "failed", "cancelled", "interrupted"].includes(value.state)) invalid();
  const start = value.start === undefined ? undefined : parsePrivateSignalStart(value.start);
  const callReservation = value.callReservation === undefined ? undefined : parsePrivateSignalCallReservation(value.callReservation,
    { localProfileId: receipt.localProfileId, agentId: receipt.agentId, jobId: value.jobId as string });
  if (Object.hasOwn(value, "callReservation") && (!callReservation || !start || callReservation.reservedAt < value.createdAt
    || callReservation.reservedAt > value.updatedAt || value.state === "received")) invalid();
  const live = value.state === "received" || value.state === "running";
  if ((value.state === "received" && (start || value.generation !== 1))
    || (value.state === "running" && (!start || value.generation !== 2))
    || (!live && value.generation !== (start ? 3 : 2))
    || ((value.state === "completed" || value.state === "failed") && !start)
    || (value.state !== "completed" && Object.hasOwn(value, "result"))
    || (value.state !== "held" && Object.hasOwn(value, "reason"))
    || (value.state !== "failed" && Object.hasOwn(value, "error"))
    || (Object.hasOwn(value, "start") && !start)) invalid();
  const result = value.state === "completed" && start ? parsePrivateSignalResult(value.result, receipt, start) : undefined;
  if (result && callReservation && privateSignalAdmissionDigest(result.admission) !== callReservation.admissionDigest) invalid();
  if (value.state === "held" && !PRIVATE_SIGNAL_HOLD_REASONS.includes(value.reason as PrivateSignalHoldReason)) invalid();
  if (value.state === "failed" && (typeof value.error !== "string" || !["provider_unavailable", "research_unavailable", "invalid_result"].includes(value.error))) invalid();
  const job: PrivateSignalJob = { kind: "signal_decision", jobId: value.jobId as string, agentId: receipt.agentId,
    originalInstanceId: receipt.instanceId, generation: value.generation, state: value.state as PrivateSignalJobState,
    createdAt: value.createdAt, updatedAt: value.updatedAt, receipt, ...(start ? { start } : {}), ...(callReservation ? { callReservation } : {}), ...(result ? { result } : {}),
    ...(value.state === "held" ? { reason: value.reason as PrivateSignalHoldReason } : {}),
    ...(value.state === "failed" ? { error: value.error as PrivateSignalFailure } : {}) };
  if (Buffer.byteLength(JSON.stringify(job), "utf8") > MAX_PRIVATE_SIGNAL_JOB_BYTES) invalid();
  return freeze(job);
}
