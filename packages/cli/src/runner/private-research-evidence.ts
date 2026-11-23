/** Pure local evidence boundary. Digests detect changed snapshots; they are not
 * server signatures, ownership proof, freshness, or execution permission. */
import { createHash } from "node:crypto";
import { runnerResearchRequestDigest, validateRunnerResearchResponse, type RunnerResearchChain,
  type RunnerResearchRequest, type RunnerResearchExpectedTarget, type RunnerResearchResponse } from "@balchemyai/agent-sdk";
import type { PrivateResearchReceipt } from "./private-research.js";

export const RESEARCH_OBSERVATION_POLICY = "observed-30m-v1" as const;
export const RESEARCH_OBSERVATION_TTL_MS = 30 * 60_000;
export const MAX_RESEARCH_SNAPSHOT_BYTES = 272 * 1024;
export interface ResearchScope { readonly localProfileId: string; readonly localAgentId: string; readonly conversationId: string }
export interface ResearchSnapshotContent { readonly version: 1; readonly scope: ResearchScope; readonly receipt: PrivateResearchReceipt }
export interface ResearchSnapshot extends ResearchSnapshotContent { readonly snapshotDigest: string }
export interface ResearchAssetRef { readonly refId: string; readonly chain: RunnerResearchChain; readonly assetId: string }
export interface SourceObservation {
  readonly source: string; readonly status: "ok" | "degraded" | "unavailable" | "unknown";
  readonly fetchedAt: string | null; readonly layer?: "provider"; readonly reason?: string;
  readonly configured?: boolean; readonly attempted?: boolean; readonly required?: boolean; readonly ok?: boolean;
  readonly rateLimited?: boolean; readonly retryable?: boolean; readonly cacheHit?: boolean; readonly dataAvailable?: boolean;
  readonly retryAfterSeconds?: number; readonly httpStatus?: number;
  readonly circuitState?: "closed" | "open" | "half_open" | "unknown";
}
export interface ResearchRisk {
  readonly reportedVerdict: string; readonly flags: readonly string[];
  readonly confidence: "low" | "medium" | "high"; readonly summary?: string;
}
export interface DiscoveryObservation {
  readonly asset: ResearchAssetRef; readonly symbol: string | null; readonly name: string | null;
  readonly source: string; readonly provenance: string; readonly observedAt: string | null;
  readonly pairAddress?: string; readonly eventId?: string; readonly canonicality?: "canonical" | null;
  readonly finality?: "sealed" | null; readonly riskCaveats: readonly string[];
  readonly marketCapUsd?: number; readonly liquidityUsd?: number; readonly volumeUsd1h?: number; readonly volumeUsd24h?: number;
}
interface CommonReport {
  readonly sources: readonly SourceObservation[]; readonly missingEvidence: readonly string[];
  readonly executionAuthority: "not_authorized_by_report";
}
export interface ExactAssetEvidence extends CommonReport {
  readonly kind: "candidate_report" | "risk_report"; readonly asset: ResearchAssetRef;
  readonly identifierBasis: "reported_identifier" | "request_only"; readonly symbol: string | null; readonly name: string | null;
  readonly risk: ResearchRisk; readonly serverEvidenceStatus: "usable" | "hold";
  readonly serverEvidenceId?: string; readonly serverEvidenceStaleAt?: string; readonly evidenceShared?: boolean;
  readonly context?: Readonly<{ summary?: string; researchStatus?: string; coverageCaveat?: string }>;
  /** K1 entry facts: the market numbers (USD) the exact report's discovery-shaped candidate carried, each only when reported. Absent
   * when none was reported. Facts for the entry filters only; never execution authority. */
  readonly market?: PrivateResearchMarketFacts;
}
export interface PrivateResearchMarketFacts {
  readonly liquidityUsd?: number; readonly marketCapUsd?: number; readonly volumeUsd1h?: number; readonly volumeUsd24h?: number;
}
export interface MarketBriefEvidence extends CommonReport {
  readonly kind: "market_brief"; readonly chain: RunnerResearchChain; readonly signals: readonly string[];
  readonly timeWindowMinutes: number; readonly candidates: readonly DiscoveryObservation[]; readonly caveats: readonly string[];
}
export type ResearchReport = ExactAssetEvidence | MarketBriefEvidence;
export type ResearchNormalizationErrorCode = "invalid_receipt" | "invalid_report" | "target_mismatch" | "invalid_snapshot" | "scope_mismatch";
export class ResearchEvidenceError extends Error {
  constructor(readonly code: ResearchNormalizationErrorCode) { super(`Local research evidence ${code}`); this.name = "ResearchEvidenceError"; }
}
export type ResearchNormalization =
  | Readonly<{ kind: "report"; snapshot: ResearchSnapshot; report: ResearchReport }>
  | Readonly<{ kind: "call_failure"; snapshot: ResearchSnapshot; result: Extract<RunnerResearchResponse["result"], { ok: false }> }>
  | Readonly<{ kind: "invalid_report"; code: ResearchNormalizationErrorCode }>;
export interface ObservedFreshness {
  readonly fetchedAt: string | null; readonly staleAt: string | null; readonly state: "fresh" | "stale" | "unknown" | "future";
}
export interface ResearchAssessment {
  readonly policy: typeof RESEARCH_OBSERVATION_POLICY;
  readonly state: "usable_research" | "discovery_only" | "hold";
  readonly sources: readonly ObservedFreshness[]; readonly candidates: readonly ObservedFreshness[];
  readonly staleAt: string | null; readonly reasons: readonly string[];
  readonly executionAuthority: "not_authorized_by_report";
}

function fail(code: ResearchNormalizationErrorCode = "invalid_report"): never { throw new ResearchEvidenceError(code); }
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!required.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...required, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function text(value: unknown, maximum = MAX_RESEARCH_SNAPSHOT_BYTES): string {
  if (typeof value !== "string" || value.length > maximum || Buffer.from(value, "utf8").toString("utf8") !== value) fail();
  return value;
}
function label(value: unknown): string | null { return value === undefined || value === null ? null : text(value); }
function strings(value: unknown, maximum = 128): string[] {
  if (!Array.isArray(value) || value.length > maximum) fail(); return value.map((item) => text(item));
}
function member<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) fail(); return value as T;
}
function iso(value: unknown): string {
  const result = text(value, 64); const time = Date.parse(result);
  if (!Number.isFinite(time)) fail(); return new Date(time).toISOString();
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function canonical(value: unknown, depth = 0): string {
  if (depth > 16) fail("invalid_snapshot");
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(text(value, MAX_RESEARCH_SNAPSHOT_BYTES));
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const fields = Object.getOwnPropertyDescriptors(value);
    if (Object.getPrototypeOf(value) !== Array.prototype || value.length > 128 || Reflect.ownKeys(value).length !== value.length + 1
      || Object.keys(value).length !== value.length || Object.values(fields).some((field) => !("value" in field))) fail("invalid_snapshot");
    return `[${Array.from({ length: value.length }, (_, index) => canonical(fields[String(index)]?.value, depth + 1)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    exact(value, Object.keys(value));
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(",")}}`;
  }
  return fail("invalid_snapshot");
}
function scope(value: unknown): ResearchScope {
  exact(value, ["localProfileId", "localAgentId", "conversationId"]);
  for (const item of Object.values(value)) if (typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(item)) fail("invalid_receipt");
  return { localProfileId: String(value.localProfileId), localAgentId: String(value.localAgentId), conversationId: String(value.conversationId) };
}
/** Explicit chain-qualified token identity. Pair addresses and labels are not accepted. */
export function assetRef(chain: RunnerResearchChain, identifier: string): ResearchAssetRef {
  if (typeof identifier !== "string" || (chain !== "base" && chain !== "solana")) fail("target_mismatch");
  const assetId = chain === "base" ? identifier.toLowerCase() : identifier;
  try { runnerResearchRequestDigest({ kind: "risk_report", chain, assetId }); } catch { fail("target_mismatch"); }
  return freeze({ refId: `asset:${chain}:${assetId}`, chain, assetId });
}
function source(value: unknown): SourceObservation {
  const bools = ["configured", "attempted", "required", "ok", "rateLimited", "retryable", "cacheHit", "dataAvailable"];
  exact(value, ["source", "status"], ["fetchedAt", "layer", "reason", ...bools, "retryAfterSeconds", "httpStatus", "circuitState"]);
  text(value.source, 256); if (!value.source) fail();
  const status = member(value.status, ["ok", "degraded", "unavailable", "unknown"] as const);
  if (value.layer !== undefined && value.layer !== "provider") fail();
  if (value.reason !== undefined) text(value.reason);
  for (const key of bools) if (value[key] !== undefined && typeof value[key] !== "boolean") fail();
  for (const key of ["retryAfterSeconds", "httpStatus"]) if (value[key] !== undefined
    && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)) fail();
  if (value.circuitState !== undefined) member(value.circuitState, ["closed", "open", "half_open", "unknown"]);
  return { ...value, source: value.source as string, status, fetchedAt: value.fetchedAt === undefined ? null : iso(value.fetchedAt) } as SourceObservation;
}
function sources(value: unknown): SourceObservation[] {
  if (!Array.isArray(value) || value.length > 64) fail(); return value.map(source);
}
const DISCOVERY_FIELDS = ["source", "provenance", "chain", "symbol", "name", "address", "mint", "pairAddress", "eventId",
  "canonicality", "finality", "volumeUsd24h", "volumeUsd1h", "liquidityUsd", "marketCapUsd", "observedAt", "riskCaveats", "suggestedNextStep"];
function candidate(value: unknown, chain: RunnerResearchChain, expectedAsset?: string): { asset: ResearchAssetRef; identifierBasis: ExactAssetEvidence["identifierBasis"]; symbol: string | null; name: string | null } {
  exact(value, [], [...DISCOVERY_FIELDS, "contract"]);
  if (value.chain !== undefined && value.chain !== chain) fail("target_mismatch");
  const ids = [value.address, value.mint, value.contract].filter((item) => item !== undefined && item !== null);
  if (!ids.length) fail("target_mismatch");
  if ((chain === "solana" && value.contract != null) || (chain === "base" && value.mint != null)) fail("target_mismatch");
  const refs = ids.map((id) => assetRef(chain, text(id, 64)));
  const asset = expectedAsset ? assetRef(chain, expectedAsset) : refs[0]!;
  if (refs.some((ref) => ref.refId !== asset.refId)) fail("target_mismatch");
  return { asset, identifierBasis: (chain === "solana" ? value.mint : value.contract) != null ? "reported_identifier" : "request_only",
    symbol: label(value.symbol), name: label(value.name) };
}
function discovery(value: unknown, chain: RunnerResearchChain): DiscoveryObservation {
  exact(value, ["source", "provenance", "chain", "riskCaveats", "suggestedNextStep"], DISCOVERY_FIELDS);
  const id = candidate(value, chain);
  text(value.suggestedNextStep);
  for (const key of ["source", "provenance", "pairAddress", "eventId"]) if (value[key] !== undefined) text(value[key]);
  if (value.canonicality !== undefined && value.canonicality !== null && value.canonicality !== "canonical") fail();
  if (value.finality !== undefined && value.finality !== null && value.finality !== "sealed") fail();
  for (const key of ["marketCapUsd", "liquidityUsd", "volumeUsd1h", "volumeUsd24h"]) if (value[key] !== undefined
    && (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0)) fail();
  const { address: _address, mint: _mint, chain: _chain, suggestedNextStep: _next, observedAt: _time, ...facts } = value;
  return { ...facts, asset: id.asset, symbol: id.symbol, name: id.name, source: String(value.source), provenance: String(value.provenance),
    observedAt: value.observedAt === undefined ? null : iso(value.observedAt), riskCaveats: strings(value.riskCaveats, 30) } as DiscoveryObservation;
}
function report(value: unknown, request: RunnerResearchRequest): ResearchReport {
  exact(value, ["reply", "structured", "trace_id", "session_cursor", "capabilities_hash", "metadata"]);
  text(value.reply, 4000); text(value.trace_id, 256); text(value.session_cursor, 256); text(value.capabilities_hash, 256);
  exact(value.metadata, ["tool", "raw_mode", "ts", "trace_id", "session_cursor", "capabilities_hash"]);
  if (value.metadata.tool !== `agent_${request.kind}` || value.metadata.raw_mode !== false) fail("target_mismatch");
  iso(value.metadata.ts);
  for (const key of ["trace_id", "session_cursor", "capabilities_hash"]) if (value.metadata[key] !== value[key]) fail();
  const s = value.structured;
  if (request.kind === "market_brief") {
    exact(s, ["query", "chain", "signals", "timeWindowMinutes", "candidateReports", "sourceHealth", "missingEvidence", "caveats"]);
    const signals = strings(s.signals, 4);
    const effectiveSignals = request.signals.length ? request.signals : ["launches", "trending", "social", "liquidity"];
    if (s.query !== null || s.chain !== request.chain || s.timeWindowMinutes !== request.timeWindowMinutes
      || JSON.stringify(signals) !== JSON.stringify(effectiveSignals)) fail("target_mismatch");
    if (!Array.isArray(s.candidateReports) || s.candidateReports.length > Math.min(12, request.limit)) fail();
    const candidates = s.candidateReports.map((row) => discovery(row, request.chain));
    if (new Set(candidates.map((row) => row.asset.refId)).size !== candidates.length) fail();
    return { kind: request.kind, chain: request.chain, signals, timeWindowMinutes: request.timeWindowMinutes, candidates,
      sources: sources(s.sourceHealth), missingEvidence: strings(s.missingEvidence), caveats: strings(s.caveats, 30), executionAuthority: "not_authorized_by_report" };
  }
  const required = ["candidate", "risk", "sourceHealth", "missingEvidence", "executionAuthority", "evidenceStatus", "referenceResolution"];
  if (request.kind === "candidate_report") required.push("query", "chain");
  exact(s, required, ["evidenceId", ...(request.kind === "candidate_report" ? ["sanitizedSummary", "evidenceStaleAt", "evidenceShared"] : [])]);
  if (request.kind === "candidate_report" && (s.query !== request.assetId || s.chain !== request.chain)) fail("target_mismatch");
  if (s.executionAuthority !== "not_authorized_by_report") fail();
  const serverEvidenceStatus = member(s.evidenceStatus, ["usable", "hold"] as const);
  exact(s.referenceResolution, ["status", "reason", "options"]);
  // The public local-runner route has no bot/conversation context and only exact identifiers.
  if (s.referenceResolution.status !== "miss" || s.referenceResolution.reason !== "NO_REFERENCE"
    || !Array.isArray(s.referenceResolution.options) || s.referenceResolution.options.length !== 0) fail();
  exact(s.candidate, [], [...DISCOVERY_FIELDS, "contract"]);
  const identity = candidate(s.candidate, request.chain, request.assetId);
  // Shared-pool fallback has the discovery candidate shape, with a held risk report.
  let market: PrivateResearchMarketFacts | undefined;
  if (s.candidate.source !== undefined) {
    const found = discovery(s.candidate, request.chain);
    const facts = Object.fromEntries((["liquidityUsd", "marketCapUsd", "volumeUsd1h", "volumeUsd24h"] as const)
      .filter((key) => typeof found[key] === "number").map((key) => [key, found[key] as number]));
    if (Object.keys(facts).length) market = facts as PrivateResearchMarketFacts;
  } else {
    exact(s.candidate, ["address"], ["symbol", "name", "mint", "contract", "canonicality", "finality"]);
    if (s.candidate.canonicality !== undefined && s.candidate.canonicality !== null) fail();
    if (s.candidate.finality !== undefined && s.candidate.finality !== null) fail();
  }
  exact(s.risk, ["verdict", "flags", "confidence"], ["summary"]);
  const risk: ResearchRisk = { reportedVerdict: text(s.risk.verdict, 256), flags: strings(s.risk.flags, 20),
    confidence: member(s.risk.confidence, ["low", "medium", "high"] as const),
    ...(s.risk.summary !== undefined ? { summary: text(s.risk.summary) } : {}) };
  let context: ExactAssetEvidence["context"];
  if (s.sanitizedSummary !== undefined) {
    exact(s.sanitizedSummary, [], ["summary", "researchStatus", "coverageCaveat"]);
    for (const item of Object.values(s.sanitizedSummary)) text(item);
    context = s.sanitizedSummary as ExactAssetEvidence["context"];
  }
  if (s.evidenceId !== undefined && (typeof s.evidenceId !== "string" || !/^asset:[0-9a-f]{16}$/.test(s.evidenceId))) fail();
  if (s.evidenceShared !== undefined && typeof s.evidenceShared !== "boolean") fail();
  return { kind: request.kind, ...identity, risk, sources: sources(s.sourceHealth), missingEvidence: strings(s.missingEvidence), serverEvidenceStatus,
    executionAuthority: "not_authorized_by_report", ...(s.evidenceId !== undefined ? { serverEvidenceId: s.evidenceId as string } : {}),
    ...(s.evidenceStaleAt !== undefined ? { serverEvidenceStaleAt: iso(s.evidenceStaleAt) } : {}),
    ...(s.evidenceShared !== undefined ? { evidenceShared: s.evidenceShared as boolean } : {}), ...(context ? { context } : {}),
    ...(market ? { market } : {}) };
}

/** Hash every accepted receipt byte (including report text), scope and acquisition target. */
export function computeSnapshotDigest(content: ResearchSnapshotContent): string {
  const serialized = canonical(content);
  if (Buffer.byteLength(serialized) > MAX_RESEARCH_SNAPSHOT_BYTES) fail("invalid_snapshot");
  return createHash("sha256").update(`["balchemy.local-research-snapshot.v1",${serialized}]`, "utf8").digest("hex");
}
function failureText(result: Extract<RunnerResearchResponse["result"], { ok: false }>): void {
  const value: unknown = JSON.parse(result.text);
  if (JSON.stringify(value) !== result.text) fail();
  exact(value, ["ok", "error"], ["budget"]);
  if (value.ok !== false) fail();
  if (value.budget === undefined) {
    if (canonical(value.error) !== canonical(result.error)) fail();
    return;
  }
  if (result.status !== "quota_blocked") fail();
  const details = result.error.details ?? {};
  if (canonical(value.error) !== canonical({ code: result.error.code, message: result.error.message, ...details })) fail();
  exact(value.budget, ["costClass", "estimatedUnits", "reason", "remainingUnits"]);
  member(value.budget.costClass, ["cheap", "medium", "expensive"]); text(value.budget.reason);
  for (const key of ["estimatedUnits", "remainingUnits"]) if (typeof value.budget[key] !== "number"
    || !Number.isFinite(value.budget[key]) || value.budget[key] < 0) fail();
}
export function normalizeResearchResponse(input: { scope: ResearchScope; receipt: PrivateResearchReceipt }): ResearchNormalization {
  try {
    exact(input, ["scope", "receipt"]); const local = scope(input.scope);
    exact(input.receipt, ["expectedTarget", "receivedAt", "response"]);
    const receivedAt = iso(input.receipt.receivedAt);
    if (receivedAt !== input.receipt.receivedAt) fail("invalid_receipt");
    let response: RunnerResearchResponse;
    try { response = validateRunnerResearchResponse(input.receipt.response, input.receipt.expectedTarget, Date.parse(receivedAt)); }
    catch { fail("invalid_receipt"); }
    // Clone only after SDK validation rejects additional keys/accessors/prototypes.
    const expectedTarget = JSON.parse(canonical(input.receipt.expectedTarget)) as RunnerResearchExpectedTarget;
    const receipt: PrivateResearchReceipt = { expectedTarget, receivedAt, response: JSON.parse(canonical(response)) as RunnerResearchResponse };
    const content: ResearchSnapshotContent = { version: 1, scope: local, receipt };
    const snapshot = { ...content, snapshotDigest: computeSnapshotDigest(content) };
    if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_RESEARCH_SNAPSHOT_BYTES) fail("invalid_snapshot");
    if (!receipt.response.result.ok) {
      failureText(receipt.response.result);
      return freeze({ kind: "call_failure", snapshot, result: receipt.response.result });
    }
    const parsed: unknown = JSON.parse(receipt.response.result.text);
    if (JSON.stringify(parsed) !== receipt.response.result.text) fail();
    const normalized = report(parsed, expectedTarget.request);
    return freeze({ kind: "report", snapshot, report: normalized });
  } catch (error: unknown) { return freeze({ kind: "invalid_report", code: error instanceof ResearchEvidenceError ? error.code : "invalid_report" }); }
}
/** Archive validation uses acquisition time, never pretends an old response just arrived. */
export function loadSnapshot(serialized: string, expectedScope: ResearchScope): Exclude<ResearchNormalization, { kind: "invalid_report" }> {
  try {
    if (typeof serialized !== "string" || Buffer.byteLength(serialized) > MAX_RESEARCH_SNAPSHOT_BYTES) fail("invalid_snapshot");
    const value: unknown = JSON.parse(serialized);
    if (JSON.stringify(value) !== serialized) fail("invalid_snapshot");
    exact(value, ["version", "scope", "receipt", "snapshotDigest"]);
    if (value.version !== 1 || typeof value.snapshotDigest !== "string" || !/^[0-9a-f]{64}$/.test(value.snapshotDigest)) fail("invalid_snapshot");
    if (canonical(scope(value.scope)) !== canonical(scope(expectedScope))) fail("scope_mismatch");
    const normalized = normalizeResearchResponse({ scope: value.scope as unknown as ResearchScope, receipt: value.receipt as PrivateResearchReceipt });
    if (normalized.kind === "invalid_report" || normalized.snapshot.snapshotDigest !== value.snapshotDigest) fail("invalid_snapshot");
    return normalized;
  } catch (error: unknown) { if (error instanceof ResearchEvidenceError) throw error; return fail("invalid_snapshot"); }
}
function observation(fetchedAt: string | null, now: number, cap?: string): ObservedFreshness {
  if (fetchedAt === null) return { fetchedAt: null, staleAt: null, state: "unknown" };
  const time = Date.parse(fetchedAt);
  const expiry = Math.min(time + RESEARCH_OBSERVATION_TTL_MS, cap === undefined ? Infinity : Date.parse(cap));
  if (!Number.isFinite(time) || !Number.isFinite(new Date(expiry).getTime())) return { fetchedAt, staleAt: null, state: "unknown" };
  return { fetchedAt, staleAt: new Date(expiry).toISOString(), state: time > now ? "future" : now >= expiry ? "stale" : "fresh" };
}
/** Assessment is transient. Re-evaluate after restart/time change; never persist it as truth. */
export function assessFreshness(report: ResearchReport, nowMs: number): ResearchAssessment {
  if (!Number.isFinite(nowMs)) fail();
  const cap = report.kind === "market_brief" ? undefined : report.serverEvidenceStaleAt;
  const sourceTimes = report.sources.map((item) => observation(item.fetchedAt, nowMs, cap));
  const candidateTimes = report.kind === "market_brief" ? report.candidates.map((item) => observation(item.observedAt, nowMs)) : [];
  const reasons: string[] = [];
  if (!report.sources.length) reasons.push("source_observations_missing");
  if (report.missingEvidence.length) reasons.push("reported_missing_evidence");
  if (report.sources.some((item) => item.status !== "ok" || item.ok === false || item.dataAvailable === false
    || item.configured === false || item.attempted === false || item.rateLimited === true || item.circuitState === "open")) reasons.push("source_unusable");
  if ([...sourceTimes, ...candidateTimes].some((item) => item.state !== "fresh")) reasons.push("observations_not_fresh");
  if (report.kind !== "market_brief") {
    if (report.serverEvidenceStatus !== "usable") reasons.push("reported_hold");
    if (!["safe", "caution", "high_risk", "allow"].includes(report.risk.reportedVerdict.trim().toLowerCase())) reasons.push("risk_verdict_unusable");
  }
  const expiries = [...sourceTimes, ...candidateTimes].map((item) => item.staleAt);
  const staleAt = expiries.length && expiries.every((item): item is string => item !== null) ? expiries.sort()[0]! : null;
  return freeze({ policy: RESEARCH_OBSERVATION_POLICY, state: reasons.length ? "hold" : report.kind === "market_brief" ? "discovery_only" : "usable_research",
    sources: sourceTimes, candidates: candidateTimes, staleAt, reasons, executionAuthority: "not_authorized_by_report" });
}
