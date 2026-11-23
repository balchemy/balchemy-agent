/** Owner-local descriptive intent only. No quote, signature, approval or submission authority. */
import { createHash } from "node:crypto";
import { deriveBehaviorRuleExecutionPolicy, toBehaviorRuleExecutionBinding, validateBehaviorRules,
  type BehaviorRuleExecutionBinding, type BehaviorRuleRevision } from "@balchemyai/agent-rules";
import { PRIVATE_RULE_EXECUTION_OPTIONS } from "./private-typed-rules.js";
import { isId, parseAgentState, runnerAgentStateKeys, type RunnerAgentState } from "./protocol.js";
import type { RuleHead } from "./private-rule-store.js";
import { assetRef, type ResearchAssetRef } from "./private-research-evidence.js";
import { validateWorkingSetRecord, type WorkingSetSelection } from "./private-working-set.js";

export const PRIVATE_SOLANA_PREVIEW_SCHEMA_VERSION = 1 as const;
const MAX_PREVIEW_BYTES = 12 * 1024;
const LAMPORTS = 1_000_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;
const HASH = /^sha256:[a-f0-9]{64}$/;
const REVISION = /^brr_[a-f0-9]{64}$/;
export interface PrivateSolanaPreviewRequest {
  intentId: string; expectedRuntimeVersion: number; expectedRevisionId: `brr_${string}` | null;
  refId: string; amountSol: string; slippageBps: number;
}
export interface PrivateSolanaPreviewScope { localProfileId: string; agentId: string; instanceId: string }
export interface PrivateSolanaPreviewInput {
  scope: PrivateSolanaPreviewScope; request: PrivateSolanaPreviewRequest; runtime: RunnerAgentState;
  rules: { head: RuleHead; revision: BehaviorRuleRevision | null };
  /** Must come from the daemon's current main-conversation selector, never an IPC/model body. */
  selection: WorkingSetSelection; nowMs: number;
}
export const PRIVATE_SOLANA_PREVIEW_GATES = ["runtime", "rules", "amount", "native_cap", "research", "entry_rules",
  "usd_cap", "position_limits", "trade_rate", "approval", "price", "balance", "spending_ceiling", "global_fee",
  "pretrade", "slippage_policy", "live_permission", "signer", "submission", "reconciliation"] as const;
export type PrivateSolanaPreviewGate = typeof PRIVATE_SOLANA_PREVIEW_GATES[number];
export type PrivateSolanaPreviewCheckStatus = "pass" | "blocked" | "unavailable" | "not_required";
export const PRIVATE_SOLANA_PREVIEW_REASONS = ["shadow_preview_only", "agent_paused", "agent_stopped", "confirmed_policy",
  "rules_missing", "rules_held", "policy_unsupported", "explicit_owner_amount", "within_native_cap", "native_cap_exceeded",
  "no_native_cap", "native_cap_not_evaluated", "fresh_research_only", "research_unresolved", "research_missing", "research_held", "no_entry_conditions",
  "entry_facts_missing", "no_usd_cap", "usd_price_missing", "portfolio_facts_missing", "no_trade_rate_limit",
  "trade_history_missing", "owner_approval_required", "approval_not_evaluated", "price_not_acquired", "balance_not_acquired",
  "ceiling_not_acquired", "fee_policy_not_acquired", "pretrade_not_performed", "slippage_policy_not_acquired",
  "live_execution_unavailable", "signer_not_attached", "submission_not_available", "reconciliation_not_available"] as const;
export interface PrivateSolanaPreviewCheck {
  gate: PrivateSolanaPreviewGate; status: PrivateSolanaPreviewCheckStatus; reason: typeof PRIVATE_SOLANA_PREVIEW_REASONS[number];
}
export interface PrivateSolanaPreviewResearchReference {
  kind: "candidate_report" | "risk_report"; sequence: number; requestId: string; snapshotDigest: string;
  serverEvidenceId: string | null; staleAt: string | null; assessment: "usable_research" | "hold";
}
export interface PrivateSolanaIntentPreview {
  schemaVersion: 1; scope: PrivateSolanaPreviewScope; request: PrivateSolanaPreviewRequest;
  source: "explicit_owner"; chain: "solana"; action: "buy"; assessedAt: string;
  asset: ResearchAssetRef; amount: { unit: "SOL"; decimal: string; baseUnits: string };
  runtime: RunnerAgentState; ruleBinding: BehaviorRuleExecutionBinding | null; nativeCapBaseUnits: string | null;
  research: PrivateSolanaPreviewResearchReference[]; checks: PrivateSolanaPreviewCheck[];
  /** Resolution is only target/amount/revision/research; missing execution gates remain mandatory. */
  resolution: "resolved" | "held"; execution: "unavailable"; armed: false; digest: `sha256:${string}`;
}
export type PrivateSolanaPreviewErrorCode = "invalid_request" | "invalid_context" | "runtime_conflict" | "revision_conflict" | "scope_conflict";
export class PrivateSolanaPreviewError extends Error {
  constructor(readonly code: PrivateSolanaPreviewErrorCode) { super(`Private intent ${code}`); this.name = "PrivateSolanaPreviewError"; }
}
function fail(code: PrivateSolanaPreviewErrorCode = "invalid_context"): never { throw new PrivateSolanaPreviewError(code); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key)) || Reflect.ownKeys(fields).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).length !== value.length
    || Object.values(fields).some((field) => !("value" in field))
    || Array.from({ length: value.length }, (_, index) => String(index)).some((key) => !Object.hasOwn(fields, key))) fail();
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value); if (result === undefined) fail(); return result;
}
function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonical(["balchemy.private-solana-intent-preview.v1", value]), "utf8").digest("hex")}`;
}
function frozen<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) frozen(child); Object.freeze(value); } return value;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function scope(value: unknown): PrivateSolanaPreviewScope {
  exact(value, ["localProfileId", "agentId", "instanceId"]);
  if (!isId(value.localProfileId) || !isId(value.agentId) || !isId(value.instanceId)) fail();
  return { localProfileId: value.localProfileId, agentId: value.agentId, instanceId: value.instanceId };
}
function solAmount(value: unknown): PrivateSolanaIntentPreview["amount"] {
  if (typeof value !== "string" || value.length > 30 || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,9})?$/.test(value)) fail("invalid_request");
  const [whole, fraction = ""] = value.split(".");
  const units = BigInt(whole!) * LAMPORTS + BigInt(fraction.padEnd(9, "0"));
  if (units <= 0n || units > U64_MAX) fail("invalid_request");
  const tail = fraction.replace(/0+$/, "");
  return { unit: "SOL", decimal: `${whole}${tail ? `.${tail}` : ""}`, baseUnits: units.toString() };
}
function requestedAsset(refId: unknown): ResearchAssetRef {
  if (typeof refId !== "string" || !refId.startsWith("asset:solana:")) fail("invalid_request");
  try { const asset = assetRef("solana", refId.slice("asset:solana:".length)); if (asset.refId !== refId) fail("invalid_request"); return asset; }
  catch { return fail("invalid_request"); }
}
export function parsePrivateSolanaPreviewRequest(value: unknown): PrivateSolanaPreviewRequest {
  try {
    exact(value, ["intentId", "expectedRuntimeVersion", "expectedRevisionId", "refId", "amountSol", "slippageBps"]);
    if (!isId(value.intentId) || !integer(value.expectedRuntimeVersion, 1)
      || (value.expectedRevisionId !== null && (typeof value.expectedRevisionId !== "string" || !REVISION.test(value.expectedRevisionId)))
      || !integer(value.slippageBps, 1, 10_000)) fail("invalid_request");
    solAmount(value.amountSol); requestedAsset(value.refId);
    return frozen({ ...value } as unknown as PrivateSolanaPreviewRequest);
  } catch { return fail("invalid_request"); }
}
/** A rule cap is a bound only. Expanding its canonical decimal representation
 * avoids amount*1e9 floating arithmetic; flooring is conservative at sub-lamport caps. */
function nativeCap(value: number | null): string | null {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0) fail();
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/);
  if (!match) fail();
  const digits = BigInt(`${match[1]}${match[2] ?? ""}`);
  const scale = 9 + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  return (scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale)).toString();
}
function check(gate: PrivateSolanaPreviewGate, status: PrivateSolanaPreviewCheckStatus,
  reason: PrivateSolanaPreviewCheck["reason"]): PrivateSolanaPreviewCheck { return { gate, status, reason }; }
const missingChecks = (): PrivateSolanaPreviewCheck[] => [
  check("price", "unavailable", "price_not_acquired"), check("balance", "unavailable", "balance_not_acquired"),
  check("spending_ceiling", "unavailable", "ceiling_not_acquired"), check("global_fee", "unavailable", "fee_policy_not_acquired"),
  check("pretrade", "unavailable", "pretrade_not_performed"), check("slippage_policy", "unavailable", "slippage_policy_not_acquired"),
  check("live_permission", "unavailable", "live_execution_unavailable"), check("signer", "unavailable", "signer_not_attached"),
  check("submission", "unavailable", "submission_not_available"), check("reconciliation", "unavailable", "reconciliation_not_available"),
];
function resolution(checks: readonly PrivateSolanaPreviewCheck[]): PrivateSolanaIntentPreview["resolution"] {
  return checks.slice(0, 5).every((item) => item.status === "pass" || item.status === "not_required") ? "resolved" : "held";
}
export function buildPrivateSolanaIntentPreview(input: PrivateSolanaPreviewInput): PrivateSolanaIntentPreview {
  const target = scope(input.scope); const request = parsePrivateSolanaPreviewRequest(input.request);
  if (!integer(input.nowMs, 0, 8_640_000_000_000_000) || !timestamp(new Date(input.nowMs).toISOString())) fail();
  const runtime = structuredClone(parseAgentState(input.runtime));
  if (runtime.agentId !== target.agentId) fail("scope_conflict");
  if (runtime.version !== request.expectedRuntimeVersion) fail("runtime_conflict");
  const { head, revision } = input.rules;
  if (head.localProfileId !== target.localProfileId || head.agentId !== target.agentId || head.chain !== "solana") fail("scope_conflict");
  if (head.revisionId !== request.expectedRevisionId) fail("revision_conflict");
  if (!integer(head.revision) || (head.state === "empty") !== (head.revisionId === null)
    || (head.revisionId === null) !== (revision === null) || (revision && (revision.revisionId !== head.revisionId
      || revision.revision !== head.revision || revision.chain !== "solana"))) fail();
  const policy = revision && head.state === "compiled" && validateBehaviorRules(revision.rules).valid
    ? deriveBehaviorRuleExecutionPolicy(revision, PRIVATE_RULE_EXECUTION_OPTIONS) : null;
  const binding = policy ? toBehaviorRuleExecutionBinding(policy) : null;
  const cap = policy ? nativeCap(policy.sizing.maxTradeNative) : null;
  const amount = solAmount(request.amountSol); const asset = requestedAsset(request.refId);
  const research: PrivateSolanaPreviewResearchReference[] = [];
  let researchReason: PrivateSolanaPreviewCheck["reason"] = "research_unresolved";
  if (input.selection.executionAuthority !== "not_authorized_by_report") fail();
  if (input.selection.kind === "resolved") {
    if (input.selection.assets.length !== 1 || canonical(input.selection.assets[0]!.asset) !== canonical(asset)) fail("scope_conflict");
    const selected = input.selection.assets[0]!;
    researchReason = "research_missing";
    for (const kind of ["candidateReport", "riskReport"] as const) {
      const supplied = selected[kind]; if (!supplied) continue;
      const record = validateWorkingSetRecord(supplied, { localProfileId: target.localProfileId, localAgentId: target.agentId, conversationId: "main" }, input.nowMs);
      if (record.evidence.kind !== "report") { researchReason = "research_held"; continue; }
      const report = record.evidence.report;
      if (report.kind === "market_brief" || report.kind !== (kind === "candidateReport" ? "candidate_report" : "risk_report")
        || canonical(report.asset) !== canonical(asset)) fail("scope_conflict");
      const assessed = record.assessment!;
      research.push({ kind: report.kind, sequence: record.sequence, requestId: record.requestId,
        snapshotDigest: record.evidence.snapshot.snapshotDigest, serverEvidenceId: report.serverEvidenceId ?? null,
        staleAt: assessed.staleAt, assessment: assessed.state === "usable_research" ? "usable_research" : "hold" });
      if (assessed.state !== "usable_research" || !report.serverEvidenceId) researchReason = "research_held";
    }
    if (research.length && researchReason !== "research_held") researchReason = "fresh_research_only";
  }
  const checks = [
    runtime.lifecycle === "stopped" ? check("runtime", "blocked", "agent_stopped") : runtime.mode === "paused"
      ? check("runtime", "blocked", "agent_paused") : check("runtime", "pass", "shadow_preview_only"),
    binding ? check("rules", "pass", "confirmed_policy") : check("rules", "blocked", !revision ? "rules_missing" : head.state === "held_requires_review" ? "rules_held" : "policy_unsupported"),
    check("amount", "pass", "explicit_owner_amount"),
    !binding ? check("native_cap", "unavailable", "native_cap_not_evaluated") : cap === null ? check("native_cap", "not_required", "no_native_cap") : BigInt(amount.baseUnits) <= BigInt(cap)
      ? check("native_cap", "pass", "within_native_cap") : check("native_cap", "blocked", "native_cap_exceeded"),
    check("research", researchReason === "fresh_research_only" ? "pass" : "blocked", researchReason),
    policy && policy.entry.conditions.length === 0 && policy.entry.signals.minRequired === 0
      ? check("entry_rules", "not_required", "no_entry_conditions") : check("entry_rules", "unavailable", "entry_facts_missing"),
    policy?.sizing.maxTradeUsd === null ? check("usd_cap", "not_required", "no_usd_cap") : check("usd_cap", "unavailable", "usd_price_missing"),
    check("position_limits", "unavailable", "portfolio_facts_missing"),
    policy?.sizing.maxTradesPerHour === null ? check("trade_rate", "not_required", "no_trade_rate_limit") : check("trade_rate", "unavailable", "trade_history_missing"),
    policy?.approval.confirmBeforeTrade ? check("approval", "blocked", "owner_approval_required") : check("approval", "unavailable", "approval_not_evaluated"),
    ...missingChecks(),
  ];
  const body = { schemaVersion: PRIVATE_SOLANA_PREVIEW_SCHEMA_VERSION, scope: target, request, source: "explicit_owner" as const,
    chain: "solana" as const, action: "buy" as const, assessedAt: new Date(input.nowMs).toISOString(), asset, amount,
    runtime, ruleBinding: binding, nativeCapBaseUnits: cap, research, checks, resolution: resolution(checks), execution: "unavailable" as const, armed: false as const };
  return parsePrivateSolanaIntentPreview({ ...body, digest: digest(body) });
}

function parseBinding(value: unknown): void {
  if (value === null) return;
  exact(value, ["schemaVersion", "revisionId", "revision", "chain", "compilerVersion", "sourceDigest", "rulesDigest", "compiledDigest", "executionPolicyDigest", "exitSnapshot"]);
  if (value.schemaVersion !== "balchemy.behavior-rule-revision.v1" || value.chain !== "solana" || !integer(value.revision, 1)
    || typeof value.revisionId !== "string" || !REVISION.test(value.revisionId)
    || typeof value.compilerVersion !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.compilerVersion) || value.compilerVersion.length > 32
    || [value.sourceDigest, value.rulesDigest, value.compiledDigest, value.executionPolicyDigest].some((item) => typeof item !== "string" || !HASH.test(item))) fail();
  const exit = value.exitSnapshot;
  exact(exit, ["stopLossBps", "takeProfitLevels"], ["trailingActivateBps", "trailingStopBps"]);
  if (!integer(exit.stopLossBps, 1, 10_000)) fail();
  array(exit.takeProfitLevels, 16);
  let previous = 0; let sold = 0;
  for (const level of exit.takeProfitLevels) {
    exact(level, ["triggerBps", "sellBps"]);
    if (!integer(level.triggerBps, 1, 100_000) || level.triggerBps <= previous || !integer(level.sellBps, 1, 10_000)) fail();
    previous = level.triggerBps; sold += level.sellBps;
  }
  if (sold > 10_000 || Object.hasOwn(exit, "trailingActivateBps") !== Object.hasOwn(exit, "trailingStopBps")) fail();
  if (Object.hasOwn(exit, "trailingActivateBps") && (!integer(exit.trailingActivateBps, 1, 100_000)
    || !integer(exit.trailingStopBps, 1, 10_000) || exit.trailingStopBps >= exit.trailingActivateBps)) fail();
}
/** Closed historical record validation, including its own digest. This does not
 * claim the rule head, runtime version or observations are still current. */
export function parsePrivateSolanaIntentPreview(value: unknown): PrivateSolanaIntentPreview {
  try {
    exact(value, ["schemaVersion", "scope", "request", "source", "chain", "action", "assessedAt", "asset", "amount", "runtime", "ruleBinding",
      "nativeCapBaseUnits", "research", "checks", "resolution", "execution", "armed", "digest"]);
    const target = scope(value.scope); const request = parsePrivateSolanaPreviewRequest(value.request);
    if (value.schemaVersion !== 1 || value.source !== "explicit_owner" || value.chain !== "solana" || value.action !== "buy"
      || value.execution !== "unavailable" || value.armed !== false || !timestamp(value.assessedAt)) fail();
    exact(value.asset, ["refId", "chain", "assetId"]); exact(value.amount, ["unit", "decimal", "baseUnits"]);
    const asset = requestedAsset(request.refId); const amount = solAmount(request.amountSol);
    if (value.asset.refId !== asset.refId || value.asset.chain !== asset.chain || value.asset.assetId !== asset.assetId
      || value.amount.unit !== amount.unit || value.amount.decimal !== amount.decimal || value.amount.baseUnits !== amount.baseUnits) fail();
    exact(value.runtime, runnerAgentStateKeys(value.runtime));
    const runtime = parseAgentState(value.runtime);
    if (runtime.agentId !== target.agentId || runtime.version !== request.expectedRuntimeVersion) fail();
    parseBinding(value.ruleBinding);
    if (value.ruleBinding !== null && (value.ruleBinding as BehaviorRuleExecutionBinding).revisionId !== request.expectedRevisionId) fail();
    if (value.nativeCapBaseUnits !== null && (typeof value.nativeCapBaseUnits !== "string" || !/^(?:0|[1-9][0-9]{0,319})$/.test(value.nativeCapBaseUnits))) fail();
    array(value.research, 2);
    const kinds = new Set<string>();
    for (const item of value.research) {
      exact(item, ["kind", "sequence", "requestId", "snapshotDigest", "serverEvidenceId", "staleAt", "assessment"]);
      if ((item.kind !== "candidate_report" && item.kind !== "risk_report") || kinds.has(item.kind) || !integer(item.sequence, 1)
        || !isId(item.requestId) || typeof item.snapshotDigest !== "string" || !/^[a-f0-9]{64}$/.test(item.snapshotDigest)
        || (item.serverEvidenceId !== null && (typeof item.serverEvidenceId !== "string" || !/^asset:[a-f0-9]{16}$/.test(item.serverEvidenceId)))
        || (item.staleAt !== null && !timestamp(item.staleAt)) || (item.assessment !== "usable_research" && item.assessment !== "hold")) fail();
      kinds.add(item.kind);
    }
    array(value.checks, PRIVATE_SOLANA_PREVIEW_GATES.length);
    if (value.checks.length !== PRIVATE_SOLANA_PREVIEW_GATES.length) fail();
    const allowed: Partial<Record<PrivateSolanaPreviewGate, readonly string[]>> = {
      runtime: ["pass:shadow_preview_only", "blocked:agent_paused", "blocked:agent_stopped"], rules: ["pass:confirmed_policy", "blocked:rules_missing", "blocked:rules_held", "blocked:policy_unsupported"],
      amount: ["pass:explicit_owner_amount"], native_cap: ["not_required:no_native_cap", "pass:within_native_cap", "blocked:native_cap_exceeded", "unavailable:native_cap_not_evaluated"],
      research: ["pass:fresh_research_only", "blocked:research_unresolved", "blocked:research_missing", "blocked:research_held"],
      entry_rules: ["not_required:no_entry_conditions", "unavailable:entry_facts_missing"], usd_cap: ["not_required:no_usd_cap", "unavailable:usd_price_missing"],
      position_limits: ["unavailable:portfolio_facts_missing"], trade_rate: ["not_required:no_trade_rate_limit", "unavailable:trade_history_missing"],
      approval: ["blocked:owner_approval_required", "unavailable:approval_not_evaluated"],
      ...Object.fromEntries(missingChecks().map((item) => [item.gate, [`${item.status}:${item.reason}`]])),
    };
    value.checks.forEach((item: unknown, index: number) => {
      exact(item, ["gate", "status", "reason"]); const gate = PRIVATE_SOLANA_PREVIEW_GATES[index]!;
      if (item.gate !== gate || typeof item.status !== "string" || typeof item.reason !== "string" || !allowed[gate]?.includes(`${item.status}:${item.reason}`)) fail();
    });
    const checks = value.checks as PrivateSolanaPreviewCheck[];
    const expectedRuntime = runtime.lifecycle === "stopped" ? "agent_stopped" : runtime.mode === "paused" ? "agent_paused" : "shadow_preview_only";
    if (checks[0]!.reason !== expectedRuntime || (checks[1]!.status === "pass") !== (value.ruleBinding !== null)) fail();
    if (value.ruleBinding === null && value.nativeCapBaseUnits !== null) fail();
    const expectedCap = value.ruleBinding === null ? "native_cap_not_evaluated" : value.nativeCapBaseUnits === null ? "no_native_cap" : BigInt(solAmount(request.amountSol).baseUnits) <= BigInt(value.nativeCapBaseUnits as string) ? "within_native_cap" : "native_cap_exceeded";
    if (checks[3]!.reason !== expectedCap || value.resolution !== resolution(checks)) fail();
    const research = value.research as PrivateSolanaPreviewResearchReference[];
    if (checks[4]!.status === "pass" && (!research.length || research.some((item) => item.assessment !== "usable_research"
      || item.serverEvidenceId === null || item.staleAt === null || Date.parse(item.staleAt) <= Date.parse(value.assessedAt as string)))) fail();
    const { digest: captured, ...body } = value;
    if (typeof captured !== "string" || !HASH.test(captured) || digest(body) !== captured || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PREVIEW_BYTES) fail();
    return frozen(structuredClone(value) as unknown as PrivateSolanaIntentPreview);
  } catch { return fail("invalid_context"); }
}
