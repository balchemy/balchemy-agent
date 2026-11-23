/** Owner-local language decision boundary. Passing admits a model call, never a trade. */
import { createHash } from "node:crypto";
import { BehaviorRuleEngine, isBehaviorRuleRevisionExecutable, isTypedEntryCondition, validateBehaviorRules,
  type BehaviorRuleRevision } from "@balchemyai/agent-rules";
import { isId, isRunnerEntriesState, isRunnerModeState, runnerAgentStateKeys, type RunnerAgentState } from "./protocol.js";
import type { RuleHead } from "./private-rule-store.js";
import { assetRef, type ResearchAssetRef } from "./private-research-evidence.js";
import { validateWorkingSetRecord, type WorkingSetRecord, type WorkingSetSelection } from "./private-working-set.js";
import { PRIVATE_RULE_EXECUTION_OPTIONS, privateAvoidOutcome, privateEntryFacts, privateTypedEntryOutcome, privateWithEntryFacts } from "./private-typed-rules.js";
import type { PrivateHolderShares } from "./private-holder-share.js";
import type { PrivateResearchMarketFacts } from "./private-research-evidence.js";

export const MAX_PRIVATE_OUTER_DECISION_BYTES = 1024;
export type PrivateOuterAction = "buy" | "sell" | "hold" | "skip";
export interface PrivateOuterDecision { readonly action: PrivateOuterAction; readonly refId: string }
export interface PrivateOuterScope { localProfileId: string; agentId: string; conversationId: string }
export interface PrivateOuterSignalContent {
  signalId: string; chain: "solana" | "base"; assetId: string; refId: string; observedAt: string;
  source: { platform: "telegram" | "discord" | "onchain" | "launchpad"; sourceId: string };
}
export interface PrivateOuterSignal extends PrivateOuterSignalContent { digest: `sha256:${string}` }
/** Any runner mode (shadow, paused, live_unarmed, live_armed). A decision never adds execution capability. */
export type PrivateOuterRuntimeState = Omit<RunnerAgentState, "mode"> & { mode: RunnerAgentState["mode"] | "live_unarmed" };
export interface PrivateOuterPrefilterInput {
  scope: PrivateOuterScope; signal: PrivateOuterSignal; runtime: PrivateOuterRuntimeState;
  expectedRuntimeVersion: number; rules: { head: RuleHead; revision: BehaviorRuleRevision | null };
  expectedRevisionId: `brr_${string}` | null; selection: WorkingSetSelection;
  nowMs: number; maximumSignalAgeMs: number;
  /** K1 top-N holder shares (private-holder-share.ts), read once by the caller before the first evaluation and passed unchanged to
   * every re-evaluation. Absent: every top_holders_pct fact is unknown (such a filter holds). Market facts come from the reports. */
  holderShares?: PrivateHolderShares;
}
export type PrivateOuterHoldReason = "scope_mismatch" | "runtime_changed" | "runtime_disallowed"
  | "signal_future" | "signal_stale" | "rules_changed" | "rules_missing" | "rules_held" | "rules_invalid"
  | "evidence_unresolved" | "evidence_missing" | "evidence_held" | "evidence_mismatch"
  | "entry_facts_missing" | "entry_signals_missing" | "entry_rule_failed" | "strategy_facts_missing";
export interface PrivateOuterEvidenceBinding {
  readonly kind: "candidate_report" | "risk_report"; readonly sequence: number; readonly snapshotDigest: string;
  readonly serverEvidenceId: string; readonly staleAt: string;
}
export interface PrivateOuterPrefilterBinding {
  readonly signalId: string; readonly signalDigest: `sha256:${string}`; readonly source: Readonly<PrivateOuterSignalContent["source"]>;
  readonly chain: "solana" | "base"; readonly assetId: string; readonly refId: string; readonly runtimeVersion: number;
  readonly revisionId: `brr_${string}`; readonly sourceDigest: string; readonly rulesDigest: string; readonly compiledDigest: string;
  readonly evidence: readonly PrivateOuterEvidenceBinding[];
}
export type PrivateOuterPrefilterResult =
  | Readonly<{ state: "passed"; reasons: readonly []; binding: PrivateOuterPrefilterBinding }>
  | Readonly<{ state: "held"; reasons: readonly PrivateOuterHoldReason[]; binding: null }>;
export class PrivateOuterDecisionError extends Error {
  constructor(readonly code: "invalid_output" | "ref_mismatch" | "invalid_context") {
    super(`Private outer decision ${code}`); this.name = "PrivateOuterDecisionError";
  }
}
function fail(code: PrivateOuterDecisionError["code"] = "invalid_context"): never { throw new PrivateOuterDecisionError(code); }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!required.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function integer(value: unknown, minimum = 0): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum; }
function timestamp(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function revisionId(value: unknown): value is `brr_${string}` { return typeof value === "string" && /^brr_[a-f0-9]{64}$/.test(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function scope(value: PrivateOuterScope): PrivateOuterScope {
  exact(value, ["localProfileId", "agentId", "conversationId"]);
  if (!isId(value.localProfileId) || !isId(value.agentId) || !isId(value.conversationId)) fail();
  return { localProfileId: value.localProfileId, agentId: value.agentId, conversationId: value.conversationId };
}
function reference(value: unknown): ResearchAssetRef {
  if (typeof value !== "string" || value.length > 80) fail();
  const parts = value.split(":");
  if (parts.length !== 3 || parts[0] !== "asset" || (parts[1] !== "solana" && parts[1] !== "base")) fail();
  try { const asset = assetRef(parts[1], parts[2]!); if (asset.refId !== value) fail(); return asset; }
  catch { return fail(); }
}
function signalContent(value: PrivateOuterSignalContent): PrivateOuterSignalContent {
  exact(value, ["signalId", "chain", "assetId", "refId", "observedAt", "source"]);
  exact(value.source, ["platform", "sourceId"]);
  const asset = reference(value.refId);
  if (!isId(value.signalId) || value.chain !== asset.chain || value.assetId !== asset.assetId || !timestamp(value.observedAt)
    || !["telegram", "discord", "onchain", "launchpad"].includes(String(value.source.platform))
    || typeof value.source.sourceId !== "string" || !/^[!-~]{1,160}$/.test(value.source.sourceId)) fail();
  return { signalId: value.signalId, chain: asset.chain, assetId: asset.assetId, refId: asset.refId, observedAt: value.observedAt,
    source: { platform: value.source.platform as PrivateOuterSignalContent["source"]["platform"], sourceId: value.source.sourceId } };
}
/** Local content binding, not authentication of a producer or a server signature. */
export function privateOuterSignalDigest(target: PrivateOuterScope, signal: PrivateOuterSignalContent): `sha256:${string}` {
  const local = scope(target); const content = signalContent(signal);
  return `sha256:${createHash("sha256").update(JSON.stringify(["balchemy.private-outer-signal.v1", local, content]), "utf8").digest("hex")}`;
}

// Exactly two string-valued JSON members. Decoded key comparison rejects duplicate
// keys, including escaped aliases; JSON.parse alone would silently keep the last.
const JSON_STRING = String.raw`"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const SPACE = "[ \\t\\r\\n]*";
const DECISION_OBJECT = new RegExp(`^${SPACE}\\{${SPACE}(${JSON_STRING})${SPACE}:${SPACE}(${JSON_STRING})${SPACE},${SPACE}(${JSON_STRING})${SPACE}:${SPACE}(${JSON_STRING})${SPACE}\\}${SPACE}$`);
export function parsePrivateOuterDecision(text: string, expectedRefId: string): PrivateOuterDecision {
  const expected = reference(expectedRefId);
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_PRIVATE_OUTER_DECISION_BYTES
    || Buffer.from(text, "utf8").toString("utf8") !== text) fail("invalid_output");
  const match = DECISION_OBJECT.exec(text); if (!match) fail("invalid_output");
  const first: unknown = JSON.parse(match[1]!); const second: unknown = JSON.parse(match[3]!);
  if (first === second || !["action", "refId"].includes(String(first)) || !["action", "refId"].includes(String(second))) fail("invalid_output");
  const action: unknown = JSON.parse(match[first === "action" ? 2 : 4]!);
  const refId: unknown = JSON.parse(match[first === "refId" ? 2 : 4]!);
  if (action !== "buy" && action !== "sell" && action !== "hold" && action !== "skip") fail("invalid_output");
  let actual: ResearchAssetRef;
  try { actual = reference(refId); } catch { return fail("invalid_output"); }
  if (actual.refId !== expected.refId) fail("ref_mismatch");
  return Object.freeze({ action, refId: actual.refId });
}

/** Closed holder-share record: `top<N>_holders_pct` keys, finite numbers or null only. */
function holderSharesOf(value: unknown): PrivateHolderShares {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object") fail();
  exact(value, Object.keys(value));
  const facts: Record<string, number | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^top[1-9][0-9]{0,3}_holders_pct$/.test(key) || (item !== null && (typeof item !== "number" || !Number.isFinite(item)))) fail();
    facts[key] = item as number | null;
  }
  return Object.freeze(facts);
}
function held(reason: PrivateOuterHoldReason): PrivateOuterPrefilterResult {
  return freeze<PrivateOuterPrefilterResult>({ state: "held", reasons: [reason], binding: null });
}
/** The caller supplies authoritative current state and a current selection. It
 * owns signal replay/cooldown admission and must recheck these bindings after
 * every asynchronous boundary. A passed result is only permission to ask the
 * model for a recommendation; amount, approval and execution gates are separate. */
export function evaluatePrivateOuterPrefilter(input: PrivateOuterPrefilterInput): PrivateOuterPrefilterResult {
  exact(input, ["scope", "signal", "runtime", "expectedRuntimeVersion", "rules", "expectedRevisionId", "selection", "nowMs", "maximumSignalAgeMs"],
    ["holderShares"]);
  const holderShares = holderSharesOf(input.holderShares);
  const target = scope(input.scope);
  if (!integer(input.nowMs) || input.nowMs > 8_640_000_000_000_000 || !integer(input.maximumSignalAgeMs, 1)
    || !integer(input.expectedRuntimeVersion, 1) || (input.expectedRevisionId !== null && !revisionId(input.expectedRevisionId))) fail();
  exact(input.signal, ["signalId", "chain", "assetId", "refId", "observedAt", "source", "digest"]);
  const { digest, ...content } = input.signal; const signal = signalContent(content);
  if (digest !== privateOuterSignalDigest(target, signal)) fail();
  const runtime = input.runtime;
  exact(runtime, runnerAgentStateKeys(runtime));
  if (!isId(runtime.agentId) || !integer(runtime.version, 1) || !integer(runtime.updatedAt)
    || !isRunnerModeState(runtime.mode, runtime.lifecycle, runtime.armed) || !isRunnerEntriesState(runtime.mode, runtime.entries)
    || runtime.execution !== "unavailable") fail();
  if (runtime.agentId !== target.agentId) return held("scope_mismatch");
  if (runtime.version !== input.expectedRuntimeVersion) return held("runtime_changed");
  // Owner pause of an armed agent: no new entry decision starts (protective exits are not decided here).
  if (runtime.mode === "paused" || runtime.lifecycle !== "idle" || runtime.entries === "paused") return held("runtime_disallowed");
  const age = input.nowMs - Date.parse(signal.observedAt);
  if (age < 0) return held("signal_future");
  if (age >= input.maximumSignalAgeMs) return held("signal_stale");
  exact(input.rules, ["head", "revision"]);
  const { head, revision } = input.rules;
  exact(head, ["localProfileId", "agentId", "chain", "revision", "revisionId", "state"], ["compilerVersion", "diagnosticCount"]);
  if (!isId(head.localProfileId) || !isId(head.agentId) || !["solana", "base"].includes(head.chain)
    || !integer(head.revision) || !["empty", "compiled", "held_requires_review"].includes(head.state)
    || (head.revisionId !== null && !revisionId(head.revisionId))) fail();
  if (head.localProfileId !== target.localProfileId || head.agentId !== target.agentId || head.chain !== signal.chain) return held("scope_mismatch");
  if (head.revisionId !== input.expectedRevisionId) return held("rules_changed");
  if (head.state === "empty" || !revision) return held("rules_missing");
  if (head.state !== "compiled") return held("rules_held");
  if (revision.revisionId !== head.revisionId || revision.revision !== head.revision || revision.chain !== signal.chain
    || !isBehaviorRuleRevisionExecutable(revision, PRIVATE_RULE_EXECUTION_OPTIONS) || !validateBehaviorRules(revision.rules).valid
    || (head.compilerVersion !== undefined && head.compilerVersion !== revision.compilerVersion)
    || (head.diagnosticCount !== undefined && head.diagnosticCount !== revision.diagnostics.length)) return held("rules_invalid");
  const selection = input.selection;
  if (!selection || selection.executionAuthority !== "not_authorized_by_report") fail();
  if (selection.kind === "unresolved") return held("evidence_unresolved");
  if (selection.kind !== "resolved" || !Array.isArray(selection.assets) || selection.assets.length !== 1) return held("evidence_mismatch");
  const selected = selection.assets[0]!;
  if (!selected?.asset || selected.asset.chain !== signal.chain || selected.asset.assetId !== signal.assetId || selected.asset.refId !== signal.refId)
    return held("evidence_mismatch");
  const evidence: PrivateOuterEvidenceBinding[] = []; const facts: Array<Record<string, unknown>> = []; const symbols = new Set<string | null>();
  const markets: (PrivateResearchMarketFacts | undefined)[] = [];
  for (const key of ["candidateReport", "riskReport"] as const) {
    const supplied = selected[key]; if (!supplied) continue;
    let record: WorkingSetRecord;
    try { record = validateWorkingSetRecord(supplied, { localProfileId: target.localProfileId, localAgentId: target.agentId, conversationId: target.conversationId }, input.nowMs); }
    catch { return held("evidence_mismatch"); }
    if (record.evidence.kind !== "report") return held("evidence_held");
    const report = record.evidence.report; const assessment = record.assessment;
    if (report.kind === "market_brief" || report.kind !== (key === "candidateReport" ? "candidate_report" : "risk_report")
      || report.asset.refId !== signal.refId || report.asset.chain !== signal.chain || report.asset.assetId !== signal.assetId) return held("evidence_mismatch");
    if (assessment?.state !== "usable_research" || !assessment.staleAt || !report.serverEvidenceId) return held("evidence_held");
    evidence.push({ kind: report.kind, sequence: record.sequence, snapshotDigest: record.evidence.snapshot.snapshotDigest,
      serverEvidenceId: report.serverEvidenceId, staleAt: assessment.staleAt });
    const verdict = report.risk.reportedVerdict.trim().toLowerCase();
    facts.push({ chain: report.asset.chain, risk_verdict: verdict, "risk.verdict": verdict });
    symbols.add(report.symbol); markets.push(report.market);
  }
  if (!evidence.length) return held("evidence_missing");
  const strategy = revision.compiled.executionStrategy;
  if (strategy?.chain && strategy.chain !== signal.chain) return held("rules_invalid");
  if (strategy?.entry && Object.keys(strategy.entry).length) return held("entry_facts_missing");
  if (strategy?.target || strategy?.sources?.length) return held("strategy_facts_missing");
  // A legacy (untyped) condition on any other field has no fact source: discovery labels, source status and model output cannot
  // fill it. Typed filters (compiler 1.3.0, entry_filters.v1) read only the caller's typed facts; an unknown one holds.
  if (revision.rules.entry.conditions.some((condition) => !isTypedEntryCondition(condition)
    && !["chain", "risk_verdict", "risk.verdict"].includes(condition.field))) return held("entry_facts_missing");
  if (revision.rules.entry.signals.minRequired > 0) return held("entry_signals_missing");
  const entryFacts = privateEntryFacts(revision.rules, markets, holderShares);
  const typedOutcome = privateTypedEntryOutcome(revision.rules, entryFacts);
  if (typedOutcome === "unknown") return held("entry_facts_missing");
  if (typedOutcome === "fail") return held("entry_rule_failed");
  // avoid.v1: the signal's mint, the reports' symbol (two different reported symbols are unknown) and no creator fact (unknown).
  const symbol = symbols.size === 1 ? [...symbols][0] ?? null : null;
  const avoid = privateAvoidOutcome(revision.rules, { mint: signal.assetId, symbol, creator: null });
  if (avoid === "unknown") return held("entry_facts_missing");
  if (avoid === "listed") return held("entry_rule_failed");
  const engine = new BehaviorRuleEngine();
  // A favorable report cannot mask a contradictory current report of the same asset. Each report record carries the same typed facts.
  if (facts.some((fact) => !engine.preCheckEntryRules(revision.rules, [privateWithEntryFacts(fact, entryFacts)]).allowed)) return held("entry_rule_failed");
  return freeze<PrivateOuterPrefilterResult>({ state: "passed", reasons: [], binding: { signalId: signal.signalId, signalDigest: digest, source: { ...signal.source },
    chain: signal.chain, assetId: signal.assetId, refId: signal.refId, runtimeVersion: runtime.version,
    revisionId: revision.revisionId, sourceDigest: revision.source.sourceDigest, rulesDigest: revision.rulesDigest,
    compiledDigest: revision.compiledDigest, evidence } });
}

/** The never-buy symbol fact of a completed decision at the build choke point: the symbol the decision's OWN bound reports carry (the
 * prefilter's rule: two different reported symbols are unknown). Every binding must be found in `selection` (the asset's current
 * working-set reports) by kind, sequence and snapshot digest; a missing, replaced or unreadable report is unknown (null), which a symbol
 * list refuses. Read-only; never execution authority. */
export function privateBoundReportSymbol(selection: WorkingSetSelection, scope: PrivateOuterScope, bindings: readonly Pick<PrivateOuterEvidenceBinding,
  "kind" | "sequence" | "snapshotDigest">[], nowMs: number): string | null {
  if (selection.kind !== "resolved" || selection.assets.length !== 1 || bindings.length === 0) return null;
  const selected = selection.assets[0]!;
  const symbols = new Set<string | null>(); let matched = 0;
  for (const key of ["candidateReport", "riskReport"] as const) {
    const supplied = selected[key]; if (!supplied) continue;
    let record: WorkingSetRecord;
    try { record = validateWorkingSetRecord(supplied, { localProfileId: scope.localProfileId, localAgentId: scope.agentId, conversationId: scope.conversationId }, nowMs); }
    catch { return null; }
    if (record.evidence.kind !== "report") return null;
    const report = record.evidence.report; const digest = record.evidence.snapshot.snapshotDigest;
    if (report.kind === "market_brief") return null;
    if (!bindings.some((item) => item.kind === report.kind && item.sequence === record.sequence && item.snapshotDigest === digest)) return null;
    matched += 1; symbols.add(report.symbol);
  }
  if (matched !== bindings.length || symbols.size !== 1) return null;
  const symbol = [...symbols][0];
  return typeof symbol === "string" && symbol.trim() ? symbol : null;
}
