/** Immutable local buy parameters. Research and a resolved amount never authorize execution. */
import { createHash } from "node:crypto";
import { BEHAVIOR_RULE_EXECUTABLE_COMPILER_VERSIONS, deriveBehaviorRuleExecutionPolicy, toBehaviorRuleExecutionBinding,
  type BehaviorRuleRevision, type BehaviorRuleExitSnapshot, type DeterministicBehaviorRuleAmountInstruction } from "@balchemyai/agent-rules";
import { isId, isTimestamp, parseAgentState, RUNNER_AGENT_MODES, type RunnerAgentMode, type RunnerAgentState } from "./protocol.js";
import { assetRef, type ResearchAssetRef } from "./private-research-evidence.js";
import { privateSignalAdmissionDigest } from "./private-autonomy.js";
import { parsePrivateSolAmount, parsePrivateBuyAmountPolicy, type PrivateBuyAmountPolicy } from "./private-sizing.js";
import type { PrivateSignalReceiptInput, PrivateSignalStart } from "./private-signal-job.js";
import type { PrivateOuterDecision, PrivateOuterPrefilterBinding } from "./private-outer-decision.js";
import type { RuleHead } from "./private-rule-store.js";
import { PRIVATE_RULE_EXECUTION_OPTIONS } from "./private-typed-rules.js";

export const MAX_PRIVATE_SIGNAL_PLAN_BYTES = 4096;
export const PRIVATE_SIGNAL_PLAN_UNAVAILABLE_GATES = ["price", "balance", "spending_ceiling", "global_fee", "pretrade",
  "slippage_policy", "positions", "trade_rate", "approval", "live_permission", "signer", "submission", "reconciliation"] as const;
export const PRIVATE_SIGNAL_PLAN_REASONS = ["decision_hold", "decision_skip", "position_authority_missing", "runtime_disallowed",
  "rules_unavailable", "compiler_unsupported", "amount_instruction_unsupported", "amount_unit_unsupported", "amount_invalid",
  "setup_policy_missing", "native_cap_exceeded", "evidence_stale", "snapshot_unrepresentable"] as const;
export type PrivateSignalPlanReason = typeof PRIVATE_SIGNAL_PLAN_REASONS[number];
export class PrivateSignalPlanError extends Error {
  constructor(readonly code: "invalid_context" | "invalid_plan" | "runtime_conflict" | "revision_conflict" | "policy_conflict") {
    super("Private signal plan " + code); this.name = "PrivateSignalPlanError";
  }
}
export interface PrivateSignalPlanContext {
  /** These records are validated by the signal job codec before historical parsing. */
  receipt: PrivateSignalReceiptInput; start: PrivateSignalStart; decision: PrivateOuterDecision;
  admission: PrivateOuterPrefilterBinding; jobId: string;
}
export interface PrivateSignalPlanInput extends PrivateSignalPlanContext {
  runtime: RunnerAgentState; rules: { head: RuleHead; revision: BehaviorRuleRevision | null };
  policy: PrivateBuyAmountPolicy | null; nowMs: number;
}
export interface PrivateSignalPlanRisk {
  maxTradeNativeBaseUnits: string | null; maxTradeUsd: number | null; maxPositionPct: number;
  maxConcurrentPositions: number; maxTradesPerHour: number | null; dailyDrawdownPausePct: number | null;
  confirmBeforeTrade: boolean; requireApprovalAboveUsd: number | null; requireApprovalForNewTokens: boolean;
  /** Compiler 1.3.0 limits (max_trades_per_day.v1, max_buys_per_token.v1), present only when the rules set them, so every earlier
   * plan keeps its exact bytes and digest. Recorded for readback; the build choke point enforces them from the live ledgers. */
  maxTradesPerDay?: number; maxBuysPerToken?: number;
}
const RISK_KEYS = ["maxTradeNativeBaseUnits", "maxTradeUsd", "maxPositionPct", "maxConcurrentPositions", "maxTradesPerHour", "dailyDrawdownPausePct",
  "confirmBeforeTrade", "requireApprovalAboveUsd", "requireApprovalForNewTokens"] as const;
const OPTIONAL_RISK_KEYS = ["maxTradesPerDay", "maxBuysPerToken"] as const;
export interface PrivateSignalPlan {
  version: 1; planId: string; jobId: string;
  scope: { localProfileId: string; agentId: string; instanceId: string };
  eventId: string; eventDigest: string; receiptDigest: string; admissionDigest: string; runtimeVersion: number;
  runtime: Pick<RunnerAgentState, "mode" | "lifecycle">; snapshot: "complete" | "bounded_hold";
  asset: ResearchAssetRef; assessedAt: number;
  state: "resolved" | "held" | "not_applicable"; reason: PrivateSignalPlanReason | null;
  amount: { amountSol: string; amountBaseUnits: string; source: "rule" | "setup_default"; statementIndex: number | null } | null;
  slippageBps: number | null; policy: PrivateBuyAmountPolicy | null;
  rule: { revisionId: string; compilerVersion: string; sourceDigest: string; rulesDigest: string; compiledDigest: string;
    executionPolicyDigest: string } | null;
  amountInstruction: DeterministicBehaviorRuleAmountInstruction | null;
  risks: PrivateSignalPlanRisk | null; exit: BehaviorRuleExitSnapshot | null;
  evidence: PrivateOuterPrefilterBinding["evidence"];
  unavailableGates: readonly typeof PRIVATE_SIGNAL_PLAN_UNAVAILABLE_GATES[number][];
  execution: "unavailable"; armed: false; digest: `sha256:${string}`;
}
function fail(code: PrivateSignalPlanError["code"] = "invalid_plan"): never { throw new PrivateSignalPlanError(code); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key)) || Reflect.ownKeys(value).length !== keys.length
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
/** Reject executable/accessor values before traversing a historical JSON snapshot. */
function json(value: unknown, depth = 0, seen = new Set<object>()): void {
  if (depth > 12) fail();
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(); return; }
  if (typeof value === "string") { if (value.length > MAX_PRIVATE_SIGNAL_PLAN_BYTES) fail(); return; }
  if (!value || typeof value !== "object" || seen.has(value)) fail(); seen.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 64
      || Reflect.ownKeys(value).length !== value.length + 1) fail();
    for (let i = 0; i < value.length; i++) {
      const field = descriptors[String(i)]; if (!field || !("value" in field) || !field.enumerable) fail();
      json(field.value, depth + 1, seen);
    }
  } else {
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length > 40) fail();
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") fail(); const field = descriptors[key]!;
      if (!("value" in field) || !field.enumerable) fail(); json(field.value, depth + 1, seen);
    }
  }
  seen.delete(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  const result = JSON.stringify(value); if (result === undefined) fail(); return result;
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function hash(domain: string, value: unknown): `sha256:${string}` {
  return ("sha256:" + createHash("sha256").update(canonical([domain, value])).digest("hex")) as `sha256:${string}`;
}
function finite(value: unknown, minimum = 0): value is number { return typeof value === "number" && Number.isFinite(value) && value >= minimum; }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function nullableNumber(value: unknown): boolean { return value === null || finite(value); }
function digest(value: unknown): value is string { return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value); }
function context(input: PrivateSignalPlanContext) {
  const { receipt, start, admission, decision, jobId } = input;
  if (![receipt.localProfileId, receipt.agentId, receipt.instanceId].every(isId) || !/^signal_[0-9a-f]{64}$/.test(jobId)
    || start.planVersion !== 1 || !(start.sizingPolicyDigest === null || digest(start.sizingPolicyDigest))
    || !positive(start.runtimeVersion) || start.ruleRevisionId !== admission.revisionId || start.runtimeVersion !== admission.runtimeVersion
    || admission.signalId !== receipt.signal.eventId || admission.source.platform !== receipt.signal.platform
    || admission.source.sourceId !== receipt.signal.sourceId || admission.chain !== receipt.signal.chain
    || admission.assetId !== receipt.signal.assetId || !["buy", "sell", "hold", "skip"].includes(decision.action)) fail("invalid_context");
  const asset = assetRef(receipt.signal.chain, receipt.signal.assetId);
  if (asset.chain !== "solana" || asset.refId !== admission.refId || asset.refId !== decision.refId) fail("invalid_context");
  return { scope: { localProfileId: receipt.localProfileId, agentId: receipt.agentId, instanceId: receipt.instanceId }, asset,
    planId: "plan_" + hash("balchemy.private-signal-plan-id.v1", [receipt.localProfileId, receipt.agentId, jobId]).slice(7),
    receiptDigest: hash("balchemy.private-signal-plan-receipt.v1", receipt),
    admissionDigest: privateSignalAdmissionDigest(admission) };
}
function cap(value: number | null): string | null {
  if (value === null) return null;
  const match = String(value).match(/^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/); if (!match || !finite(value)) fail("invalid_context");
  const digits = BigInt(match[1]! + (match[2] ?? "")); const scale = 9 + Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  return (scale >= 0 ? digits * 10n ** BigInt(scale) : digits / 10n ** BigInt(-scale)).toString();
}
function instruction(value: unknown): DeterministicBehaviorRuleAmountInstruction | null {
  if (value === null) return null;
  json(value); if (!value || typeof value !== "object") fail(); const v = value as Record<string, unknown>;
  if (v.schemaVersion !== "balchemy.behavior-rule-amount-instruction.v1") fail();
  if (v.state === "absent") exact(v, ["schemaVersion", "state"]);
  else if (v.state === "unsupported") {
    exact(v, ["schemaVersion", "state", "reason"]);
    if (!["ambiguous", "unsupported_expression", "invalid_decimal", "chain_conflict"].includes(String(v.reason))) fail();
  } else if (v.state === "exact") {
    exact(v, ["schemaVersion", "state", "action", "decimal", "unit", "statementIndex"]);
    if (v.action !== "buy" || typeof v.decimal !== "string" || v.decimal.length > 100
      || !/^(0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(v.decimal) || !/[1-9]/.test(v.decimal)
      || !["SOL", "ETH", "USD", "USDC"].includes(String(v.unit))
      || !Number.isSafeInteger(v.statementIndex) || Number(v.statementIndex) < 0) fail();
  } else fail();
  return structuredClone(v) as unknown as DeterministicBehaviorRuleAmountInstruction;
}
function amountFrom(instruction: DeterministicBehaviorRuleAmountInstruction | null, policy: PrivateBuyAmountPolicy | null): PrivateSignalPlan["amount"] {
  try {
    if (instruction?.state === "exact" && instruction.unit === "SOL") return { ...parsePrivateSolAmount(instruction.decimal), source: "rule", statementIndex: instruction.statementIndex };
    if (instruction?.state === "absent" && policy) return { ...parsePrivateSolAmount(policy.amountSol), source: "setup_default", statementIndex: null };
  } catch { /* Explicit unrepresentable amount stays held; never fall back. */ }
  return null;
}
function outcome(plan: Omit<PrivateSignalPlan, "digest" | "state" | "reason">, decision: PrivateOuterDecision): Pick<PrivateSignalPlan, "state" | "reason"> {
  if (plan.runtime.mode === "paused" || plan.runtime.lifecycle !== "idle") return { state: "held", reason: "runtime_disallowed" };
  if (decision.action === "hold" || decision.action === "skip") return { state: "not_applicable", reason: decision.action === "hold" ? "decision_hold" : "decision_skip" };
  if (decision.action === "sell") return { state: "held", reason: "position_authority_missing" };
  if (plan.amountInstruction?.state === "unsupported") return { state: "held", reason: "amount_instruction_unsupported" };
  if (plan.amountInstruction?.state === "exact" && plan.amountInstruction.unit !== "SOL") return { state: "held", reason: "amount_unit_unsupported" };
  if (plan.snapshot === "bounded_hold") return { state: "held", reason: "snapshot_unrepresentable" };
  if (!plan.rule) return { state: "held", reason: plan.amountInstruction ? "rules_unavailable" : "compiler_unsupported" };
  if (!plan.policy) return { state: "held", reason: "setup_policy_missing" };
  if (!plan.amount) return { state: "held", reason: "amount_invalid" };
  if (plan.risks?.maxTradeNativeBaseUnits !== null && plan.risks?.maxTradeNativeBaseUnits !== undefined
    && BigInt(plan.amount.amountBaseUnits) > BigInt(plan.risks.maxTradeNativeBaseUnits)) return { state: "held", reason: "native_cap_exceeded" };
  if (!plan.evidence.length || plan.evidence.some((item) => !Number.isFinite(Date.parse(item.staleAt)) || plan.assessedAt >= Date.parse(item.staleAt)))
    return { state: "held", reason: "evidence_stale" };
  return { state: "resolved", reason: null };
}
export function buildPrivateSignalPlan(input: PrivateSignalPlanInput): PrivateSignalPlan {
  const bound = context(input); const runtime = parseAgentState(input.runtime);
  if (runtime.agentId !== input.receipt.agentId || runtime.version !== input.start.runtimeVersion) fail("runtime_conflict");
  if (!isTimestamp(input.nowMs) || !Number.isFinite(new Date(input.nowMs).getTime())) fail("invalid_context");
  const { head, revision } = input.rules;
  if (head.localProfileId !== bound.scope.localProfileId || head.agentId !== bound.scope.agentId || head.chain !== "solana"
    || head.revisionId !== input.start.ruleRevisionId || !revision || revision.revisionId !== head.revisionId
    || revision.revision !== head.revision || revision.chain !== "solana"
    || revision.source.sourceDigest !== input.admission.sourceDigest || revision.rulesDigest !== input.admission.rulesDigest
    || revision.compiledDigest !== input.admission.compiledDigest) fail("revision_conflict");
  const policy = input.policy === null ? null : parsePrivateBuyAmountPolicy(input.policy, { localProfileId: bound.scope.localProfileId, agentId: bound.scope.agentId });
  if ((policy?.digest ?? null) !== input.start.sizingPolicyDigest) fail("policy_conflict");
  if (policy && policy.updatedAt > input.nowMs) fail("invalid_context");
  // 1.2.0 only adds the explicit approval record; 1.1.0 plans keep working (their approval stays required).
  const supported = BEHAVIOR_RULE_EXECUTABLE_COMPILER_VERSIONS.includes(revision.compilerVersion) && revision.compiled.amountInstruction !== undefined;
  const amountInstruction = supported ? instruction(revision.compiled.amountInstruction) : null;
  const executionPolicy = supported && head.state === "compiled" ? deriveBehaviorRuleExecutionPolicy(revision, PRIVATE_RULE_EXECUTION_OPTIONS) : null;
  const binding = executionPolicy ? toBehaviorRuleExecutionBinding(executionPolicy) : null;
  const amount = amountFrom(amountInstruction, policy);
  const base: Omit<PrivateSignalPlan, "digest" | "state" | "reason"> = {
    version: 1, planId: bound.planId, jobId: input.jobId, scope: bound.scope, asset: bound.asset,
    eventId: input.receipt.signal.eventId, eventDigest: input.receipt.signal.eventDigest, receiptDigest: bound.receiptDigest, admissionDigest: bound.admissionDigest,
    runtimeVersion: runtime.version, runtime: { mode: runtime.mode, lifecycle: runtime.lifecycle }, snapshot: "complete", assessedAt: input.nowMs, amount, slippageBps: policy?.slippageBps ?? null, policy,
    rule: binding ? { revisionId: binding.revisionId, compilerVersion: binding.compilerVersion, sourceDigest: binding.sourceDigest,
      rulesDigest: binding.rulesDigest, compiledDigest: binding.compiledDigest, executionPolicyDigest: binding.executionPolicyDigest } : null,
    amountInstruction, risks: executionPolicy && binding ? { maxTradeNativeBaseUnits: cap(executionPolicy.sizing.maxTradeNative),
      maxTradeUsd: executionPolicy.sizing.maxTradeUsd, maxPositionPct: executionPolicy.sizing.maxPositionPct,
      maxConcurrentPositions: executionPolicy.sizing.maxConcurrentPositions, maxTradesPerHour: executionPolicy.sizing.maxTradesPerHour,
      dailyDrawdownPausePct: revision.rules.risk.dailyDrawdownPausePct ?? null, ...executionPolicy.approval,
      ...(executionPolicy.sizing.maxTradesPerDay === undefined ? {} : { maxTradesPerDay: executionPolicy.sizing.maxTradesPerDay }),
      ...(executionPolicy.sizing.maxBuysPerToken === undefined ? {} : { maxBuysPerToken: executionPolicy.sizing.maxBuysPerToken }) } : null,
    exit: binding?.exitSnapshot ?? null, evidence: structuredClone(input.admission.evidence),
    unavailableGates: [...PRIVATE_SIGNAL_PLAN_UNAVAILABLE_GATES], execution: "unavailable", armed: false,
  };
  let body = { ...base, ...outcome(base, input.decision) };
  if (Buffer.byteLength(JSON.stringify({ ...body, digest: `sha256:${"0".repeat(64)}` }), "utf8") > MAX_PRIVATE_SIGNAL_PLAN_BYTES) {
    const bounded = { ...base, snapshot: "bounded_hold" as const, amount: null, amountInstruction: null, risks: null, exit: null };
    body = { ...bounded, ...outcome(bounded, input.decision) };
  }
  return parsePrivateSignalPlan({ ...body, digest: hash("balchemy.private-signal-plan.v1", body) }, input);
}
export function parsePrivateSignalPlan(value: unknown, input: PrivateSignalPlanContext): PrivateSignalPlan {
  const bound = context(input);
  json(value);
  exact(value, ["version", "planId", "jobId", "scope", "eventId", "eventDigest", "receiptDigest", "admissionDigest", "runtimeVersion", "runtime", "snapshot", "asset", "assessedAt",
    "state", "reason", "amount", "slippageBps", "policy", "rule", "amountInstruction", "risks", "exit", "evidence", "unavailableGates", "execution", "armed", "digest"]);
  if (value.version !== 1 || value.planId !== bound.planId || value.jobId !== input.jobId || canonical(value.scope) !== canonical(bound.scope)
    || canonical(value.asset) !== canonical(bound.asset) || value.eventId !== input.receipt.signal.eventId || value.eventDigest !== input.receipt.signal.eventDigest
    || value.receiptDigest !== bound.receiptDigest || value.admissionDigest !== bound.admissionDigest || value.runtimeVersion !== input.start.runtimeVersion
    || !isTimestamp(value.assessedAt) || !Number.isFinite(new Date(value.assessedAt).getTime())
    || value.execution !== "unavailable" || value.armed !== false
    || canonical(value.unavailableGates) !== canonical(PRIVATE_SIGNAL_PLAN_UNAVAILABLE_GATES)
    || canonical(value.evidence) !== canonical(input.admission.evidence)) fail();
  exact(value.runtime, ["mode", "lifecycle"]);
  // Historical plans carry shadow/paused; plans decided after S8a may carry a live mode. Neither authorizes execution.
  if (!RUNNER_AGENT_MODES.includes(value.runtime.mode as RunnerAgentMode) || !["idle", "stopped"].includes(String(value.runtime.lifecycle))
    || !["complete", "bounded_hold"].includes(String(value.snapshot))) fail();
  const policy = value.policy === null ? null : parsePrivateBuyAmountPolicy(value.policy, { localProfileId: bound.scope.localProfileId, agentId: bound.scope.agentId });
  if ((policy?.digest ?? null) !== input.start.sizingPolicyDigest || value.slippageBps !== (policy?.slippageBps ?? null)
    || policy && policy.updatedAt > value.assessedAt) fail();
  const amountInstruction = instruction(value.amountInstruction);
  if (value.amount !== null) {
    exact(value.amount, ["amountSol", "amountBaseUnits", "source", "statementIndex"]);
    const amount = parsePrivateSolAmount(value.amount.amountSol);
    if (amount.amountSol !== value.amount.amountSol || amount.amountBaseUnits !== value.amount.amountBaseUnits) fail();
    if (value.amount.source === "rule") {
      if (amountInstruction?.state !== "exact" || amountInstruction.unit !== "SOL" || amountInstruction.decimal !== amount.amountSol
        || value.amount.statementIndex !== amountInstruction.statementIndex) fail();
    } else if (value.amount.source !== "setup_default" || amountInstruction?.state !== "absent" || !policy
      || amount.amountSol !== policy.amountSol || value.amount.statementIndex !== null) fail();
  }
  if (value.snapshot === "bounded_hold") {
    if (value.amount !== null || value.amountInstruction !== null || value.risks !== null || value.exit !== null) fail();
  } else if (canonical(value.amount) !== canonical(amountFrom(amountInstruction, policy))) fail();
  if (value.rule !== null) {
    exact(value.rule, ["revisionId", "compilerVersion", "sourceDigest", "rulesDigest", "compiledDigest", "executionPolicyDigest"]);
    if (value.rule.revisionId !== input.admission.revisionId || value.rule.sourceDigest !== input.admission.sourceDigest
      || value.rule.rulesDigest !== input.admission.rulesDigest || value.rule.compiledDigest !== input.admission.compiledDigest
      || typeof value.rule.compilerVersion !== "string" || !BEHAVIOR_RULE_EXECUTABLE_COMPILER_VERSIONS.includes(value.rule.compilerVersion) || !digest(value.rule.executionPolicyDigest) || value.snapshot === "complete" && !amountInstruction) fail();
  }
  if (value.snapshot === "complete" && ((value.rule === null) !== (value.risks === null) || (value.rule === null) !== (value.exit === null))) fail();
  if (value.risks !== null) {
    const present = value.risks && typeof value.risks === "object" ? OPTIONAL_RISK_KEYS.filter((key) => Object.hasOwn(value.risks as object, key)) : [];
    exact(value.risks, [...RISK_KEYS, ...present]);
    const risk = value.risks;
    if (present.some((key) => !positive(risk[key]))) fail();
    if (risk.maxTradeNativeBaseUnits !== null && (typeof risk.maxTradeNativeBaseUnits !== "string" || !/^(0|[1-9][0-9]{0,319})$/.test(risk.maxTradeNativeBaseUnits))) fail();
    if (![risk.maxTradeUsd, risk.maxTradesPerHour, risk.dailyDrawdownPausePct, risk.requireApprovalAboveUsd].every(nullableNumber)
      || !finite(risk.maxPositionPct, Number.EPSILON) || risk.maxPositionPct > 100 || !positive(risk.maxConcurrentPositions)
      || risk.maxTradesPerHour !== null && !positive(risk.maxTradesPerHour)
      || risk.dailyDrawdownPausePct !== null && !finite(risk.dailyDrawdownPausePct, Number.EPSILON)
      || typeof risk.confirmBeforeTrade !== "boolean" || typeof risk.requireApprovalForNewTokens !== "boolean") fail();
    if (!value.exit || typeof value.exit !== "object") fail();
    exact(value.exit, ["stopLossBps", "takeProfitLevels", ...("trailingActivateBps" in (value.exit as object) ? ["trailingActivateBps"] : []),
      ...("trailingStopBps" in (value.exit as object) ? ["trailingStopBps"] : [])]);
    const exit = value.exit;
    if (!positive(exit.stopLossBps) || exit.stopLossBps > 10000 || !Array.isArray(exit.takeProfitLevels) || exit.takeProfitLevels.length > 16) fail();
    let previous = 0; let total = 0;
    for (const level of exit.takeProfitLevels) { exact(level, ["triggerBps", "sellBps"]);
      if (!positive(level.triggerBps) || level.triggerBps > 100000 || level.triggerBps <= previous || !positive(level.sellBps) || level.sellBps > 10000) fail();
      previous = level.triggerBps; total += level.sellBps; if (total > 10000) fail(); }
    if ((exit.trailingActivateBps === undefined) !== (exit.trailingStopBps === undefined)
      || exit.trailingActivateBps !== undefined && (!positive(exit.trailingActivateBps) || !positive(exit.trailingStopBps) || Number(exit.trailingStopBps) > 10000
        || Number(exit.trailingActivateBps) > 100000 || Number(exit.trailingStopBps) >= Number(exit.trailingActivateBps))) fail();
  }
  if (!["resolved", "held", "not_applicable"].includes(String(value.state))
    || value.reason !== null && !PRIVATE_SIGNAL_PLAN_REASONS.includes(value.reason as PrivateSignalPlanReason)) fail();
  const { digest: supplied, ...body } = value;
  if (!digest(supplied) || supplied !== hash("balchemy.private-signal-plan.v1", body)) fail();
  const expected = outcome(body as unknown as Omit<PrivateSignalPlan, "digest" | "state" | "reason">, input.decision);
  if (value.state !== expected.state || value.reason !== expected.reason) fail();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PRIVATE_SIGNAL_PLAN_BYTES) fail();
  return freeze(structuredClone(value) as unknown as PrivateSignalPlan);
}
