/** Bounded private-model context, projected from validated public facts only. */
import type { RunnerResearchChain, RunnerResearchFailureStatus } from "@balchemyai/agent-sdk";
import { assetRef, type DiscoveryObservation, type ExactAssetEvidence,
  type MarketBriefEvidence, type ObservedFreshness, type ResearchAssessment, type ResearchAssetRef,
  type ResearchScope, type SourceObservation } from "./private-research-evidence.js";
import { workingSetRecordScope, workingSetRecordRequest, workingSetRecordDigest, validateWorkingSetRecord,
  type LocalResearchFailureReason, type WorkingSetRetention, type WorkingSetRecord, type WorkingSetSelection, type WorkingSetView } from "./private-working-set.js";
import { isId } from "./protocol.js";

export const MAX_WORKING_CONTEXT_BYTES = 48 * 1024;
export interface ContextText { readonly text: string; readonly truncated: boolean }
export interface ContextItems<T> { readonly items: readonly T[]; readonly omitted: number }
export interface ContextAssessment {
  readonly policy: ResearchAssessment["policy"]; readonly state: ResearchAssessment["state"];
  readonly staleAt: string | null; readonly reasons: readonly string[];
}
export interface ContextSource {
  readonly source: ContextText; readonly status: SourceObservation["status"]; readonly freshness: ObservedFreshness;
  readonly reason?: ContextText; readonly configured?: boolean; readonly attempted?: boolean; readonly required?: boolean;
  readonly ok?: boolean; readonly rateLimited?: boolean; readonly retryable?: boolean; readonly cacheHit?: boolean;
  readonly dataAvailable?: boolean; readonly retryAfterSeconds?: number; readonly httpStatus?: number;
  readonly circuitState?: SourceObservation["circuitState"];
}
export interface ContextDiscovery {
  readonly ordinal: number; readonly asset: ResearchAssetRef; readonly symbol: ContextText | null; readonly name: ContextText | null;
  readonly source: ContextText; readonly provenance: ContextText; readonly freshness: ObservedFreshness; readonly contextOnly: boolean;
  readonly canonicality?: "canonical" | null; readonly finality?: "sealed" | null;
  readonly marketCapUsd?: number; readonly liquidityUsd?: number; readonly volumeUsd1h?: number; readonly volumeUsd24h?: number;
  readonly riskCaveats: ContextItems<ContextText>;
}
export type ContextOutcome = Readonly<{ kind: "report"; assessment: ContextAssessment }>
  | Readonly<{ kind: "call_failure"; status: RunnerResearchFailureStatus; code: string }>
  | Readonly<{ kind: "local_failure"; reason: LocalResearchFailureReason; failedAt: string }>;
export interface ContextActiveList {
  readonly chain: RunnerResearchChain; readonly latestAttemptSequence: number; readonly latestAttempt: ContextOutcome;
  readonly contextSequence: number | null; readonly contextState: "absent" | "empty" | "populated";
  readonly contextOnly: boolean; readonly assessment: ContextAssessment | null;
  readonly signals: readonly string[]; readonly timeWindowMinutes: number | null;
  readonly orderedAssets: readonly ContextDiscovery[]; readonly sources: ContextItems<ContextSource>;
  readonly missingEvidence: ContextItems<ContextText>; readonly caveats: ContextItems<ContextText>;
}
export interface ContextExactReport {
  readonly sequence: number; readonly kind: "candidate_report" | "risk_report"; readonly asset: ResearchAssetRef;
  readonly outcome: ContextOutcome;
  readonly details: Readonly<{ symbol: ContextText | null; name: ContextText | null;
    identifierBasis: ExactAssetEvidence["identifierBasis"]; serverEvidenceStatus: ExactAssetEvidence["serverEvidenceStatus"];
    risk: { reportedVerdict: ContextText; confidence: ExactAssetEvidence["risk"]["confidence"];
      flags: ContextItems<ContextText>; summary: ContextText | null };
    sources: ContextItems<ContextSource>; missingEvidence: ContextItems<ContextText>;
    summary: ContextText | null; researchStatus: ContextText | null; coverageCaveat: ContextText | null }> | null;
  readonly detailsOmitted: boolean;
}
export type ContextSelection =
  | Readonly<{ kind: "resolved"; assets: readonly Readonly<{ asset: ResearchAssetRef;
    discovery?: Readonly<{ sequence: number; ordinal: number; contextOnly: boolean;
      assessment: ContextAssessment; freshness: ObservedFreshness }>;
    candidateReportSequence?: number; riskReportSequence?: number }>[] }>
  | Readonly<{ kind: "unresolved"; reason: Extract<WorkingSetSelection, { kind: "unresolved" }> ["reason"];
    options: readonly ResearchAssetRef[] }>;
export interface PrivateWorkingContext {
  readonly version: 1; readonly scope: ResearchScope; readonly assessedAt: string;
  readonly executionAuthority: "not_authorized_by_report";
  readonly activeLists: readonly ContextActiveList[]; readonly exactReports: readonly ContextExactReport[];
  readonly selection: ContextSelection | null;
  readonly truncation: Readonly<{ maximumBytes: number; listDetail: "full" | "compact";
    sourceRecords: number; latestExactReports: number; omittedExactReports: number;
    supersededExactReports: number; historicalBriefReports: number; retention?: WorkingSetRetention }>;
}
export interface WorkingContextInput { scope: ResearchScope; view: WorkingSetView; selection?: WorkingSetSelection; nowMs: number }
export class PrivateWorkingContextError extends Error {
  constructor(readonly code: "invalid_context" | "scope_mismatch") { super(`Private working context ${code}`); this.name = "PrivateWorkingContextError"; }
}
type RecordView = WorkingSetRecord;
interface Active { chain: RunnerResearchChain; latest: RecordView; context?: RecordView }
interface CanonicalView { retention?: WorkingSetRetention; records: RecordView[]; active: Active[]; exact: RecordView[]; bySequence: Map<number, RecordView> }
function fail(code: PrivateWorkingContextError["code"] = "invalid_context"): never { throw new PrivateWorkingContextError(code); }
function freeze<T>(value: T): T { if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function sameScope(a: ResearchScope, b: ResearchScope): boolean {
  return a.localProfileId === b.localProfileId && a.localAgentId === b.localAgentId && a.conversationId === b.conversationId;
}
function scope(value: ResearchScope): ResearchScope {
  if (!value || !isId(value.localProfileId) || !isId(value.localAgentId) || !isId(value.conversationId)
    || Object.keys(value).length !== 3) fail();
  return { localProfileId: value.localProfileId, localAgentId: value.localAgentId, conversationId: value.conversationId };
}
function text(value: string, bytes = 192): ContextText {
  if (Buffer.byteLength(value, "utf8") <= bytes) return { text: value, truncated: false };
  let result = ""; let size = 0;
  for (const character of value) { const length = Buffer.byteLength(character); if (size + length > bytes) break; result += character; size += length; }
  return { text: result, truncated: true };
}
function optionalText(value: string | null | undefined, bytes = 192): ContextText | null { return value == null ? null : text(value, bytes); }
function items<T, U>(values: readonly T[], maximum: number, project: (value: T, index: number) => U): ContextItems<U> {
  return { items: values.slice(0, maximum).map(project), omitted: Math.max(0, values.length - maximum) };
}
function assessment(value: ResearchAssessment): ContextAssessment {
  return { policy: value.policy, state: value.state, staleAt: value.staleAt, reasons: [...value.reasons] };
}
function outcome(value: RecordView): ContextOutcome {
  if (value.evidence.kind === "call_failure") return { kind: "call_failure", status: value.evidence.result.status, code: value.evidence.result.error.code };
  if (value.evidence.kind === "local_failure") return { kind: "local_failure", reason: value.evidence.marker.reason, failedAt: value.evidence.marker.failedAt };
  return { kind: "report", assessment: assessment(value.assessment!) };
}
function held(value: RecordView): boolean { return value.evidence.kind !== "report" || value.assessment?.state === "hold"; }
function source(value: SourceObservation, freshness: ObservedFreshness, compact: boolean): ContextSource {
  return { source: text(value.source, compact ? 64 : 128), status: value.status, freshness,
    ...(value.reason === undefined ? {} : { reason: text(value.reason, compact ? 96 : 256) }),
    ...Object.fromEntries((["configured", "attempted", "required", "ok", "rateLimited", "retryable", "cacheHit", "dataAvailable",
      "retryAfterSeconds", "httpStatus", "circuitState"] as const).flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]])) };
}
function discovery(value: DiscoveryObservation, index: number, freshness: ObservedFreshness, contextOnly: boolean, compact: boolean): ContextDiscovery {
  return { ordinal: index + 1, asset: value.asset, symbol: optionalText(value.symbol, compact ? 48 : 96), name: optionalText(value.name, compact ? 64 : 128),
    source: text(value.source, compact ? 48 : 96), provenance: text(value.provenance, compact ? 64 : 128), freshness, contextOnly,
    ...Object.fromEntries((["canonicality", "finality", "marketCapUsd", "liquidityUsd", "volumeUsd1h", "volumeUsd24h"] as const)
      .flatMap((key) => value[key] === undefined ? [] : [[key, value[key]]])),
    riskCaveats: items(value.riskCaveats, compact ? 0 : 2, (item) => text(item, 160)) };
}
function market(value: RecordView | undefined): MarketBriefEvidence | undefined {
  return value?.evidence.kind === "report" && value.evidence.report.kind === "market_brief" ? value.evidence.report : undefined;
}
function active(value: Active, compact: boolean): ContextActiveList {
  const report = market(value.context); const assessed = value.context?.assessment;
  const contextOnly = held(value.latest) || !assessed || assessed.state === "hold";
  return { chain: value.chain, latestAttemptSequence: value.latest.sequence, latestAttempt: outcome(value.latest),
    contextSequence: value.context?.sequence ?? null, contextState: !report ? "absent" : report.candidates.length ? "populated" : "empty",
    contextOnly, assessment: assessed ? assessment(assessed) : null, signals: report ? [...report.signals] : [], timeWindowMinutes: report?.timeWindowMinutes ?? null,
    orderedAssets: report?.candidates.map((row, index) => discovery(row, index, assessed!.candidates[index]!, contextOnly, compact)) ?? [],
    sources: items(report?.sources ?? [], compact ? 2 : 8, (row, index) => source(row, assessed!.sources[index]!, compact)),
    missingEvidence: items(report?.missingEvidence ?? [], compact ? 2 : 6, (row) => text(row, 192)),
    caveats: items(report?.caveats ?? [], compact ? 0 : 3, (row) => text(row, 192)) };
}
function exactReport(value: RecordView, details: boolean): ContextExactReport {
  const request = workingSetRecordRequest(value); if (request.kind === "market_brief") fail();
  const report = value.evidence.kind === "report" ? value.evidence.report : undefined;
  if (report?.kind === "market_brief") fail();
  return { sequence: value.sequence, kind: request.kind, asset: assetRef(request.chain, request.assetId), outcome: outcome(value),
    details: !details || !report ? null : { symbol: optionalText(report.symbol, 96), name: optionalText(report.name, 128),
      identifierBasis: report.identifierBasis, serverEvidenceStatus: report.serverEvidenceStatus,
      risk: { reportedVerdict: text(report.risk.reportedVerdict, 192), confidence: report.risk.confidence,
        flags: items(report.risk.flags, 6, (row) => text(row, 192)), summary: optionalText(report.risk.summary, 768) },
      sources: items(report.sources, 8, (row, index) => source(row, value.assessment!.sources[index]!, false)),
      missingEvidence: items(report.missingEvidence, 6, (row) => text(row, 192)),
      summary: optionalText(report.context?.summary, 512), researchStatus: optionalText(report.context?.researchStatus), coverageCaveat: optionalText(report.context?.coverageCaveat) },
    detailsOmitted: !!report && !details };
}
function referenced(value: WorkingSetRecord, view: CanonicalView, expected: ResearchScope): RecordView {
  if (!value?.evidence || !sameScope(workingSetRecordScope(value), expected)) fail("scope_mismatch");
  const found = view.bySequence.get(value.sequence);
  if (!found || found.evidence.kind !== value.evidence.kind || workingSetRecordDigest(found) !== workingSetRecordDigest(value)) fail(); return found;
}
function canonicalView(value: WorkingSetView, expected: ResearchScope, now: number): CanonicalView {
  if (!sameScope(scope(value.scope), expected)) fail("scope_mismatch");
  if (value.executionAuthority !== "not_authorized_by_report" || !Array.isArray(value.records) || value.records.length > 128
    || !Array.isArray(value.activeLists) || value.activeLists.length > 2) fail();
  let previous = 0; const bySequence = new Map<number, RecordView>(); const lists = new Map<RunnerResearchChain, Active>(); const exact = new Map<string, RecordView>();
  const records = value.records.map((entry): RecordView => {
    if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previous) fail(); previous = entry.sequence;
    if (!sameScope(workingSetRecordScope(entry), expected)) fail("scope_mismatch");
    const row = validateWorkingSetRecord(entry, expected, now); const evidence = row.evidence;
    bySequence.set(row.sequence, row); const request = workingSetRecordRequest(row);
    if (request.kind === "market_brief") lists.set(request.chain, { chain: request.chain, latest: row,
      context: evidence.kind === "report" ? row : lists.get(request.chain)?.context });
    else exact.set(`${request.kind}:${assetRef(request.chain, request.assetId).refId}`, row);
    return row;
  });
  let retention: WorkingSetRetention | undefined;
  if (value.retention !== undefined) {
    const item = value.retention;
    if (!item || typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype
      || Reflect.ownKeys(item).length !== 3 || Object.keys(item).sort().join(",") !== "archivedRecords,omittedRecords,totalRecords"
      || Object.values(Object.getOwnPropertyDescriptors(item)).some((field) => !("value" in field) || !field.enumerable)
      || !Object.values(item).every((count) => Number.isSafeInteger(count) && count >= 0)
      || item.totalRecords < records.length || item.omittedRecords !== item.totalRecords - records.length
      || item.archivedRecords > item.totalRecords) fail();
    retention = { totalRecords: item.totalRecords, archivedRecords: item.archivedRecords, omittedRecords: item.omittedRecords };
  }
  const result = { ...(retention ? { retention } : {}), records, bySequence, active: [...lists.values()].sort((a, b) => a.chain.localeCompare(b.chain)), exact: [...exact.values()].sort((a, b) => b.sequence - a.sequence) };
  if (value.activeLists.length !== result.active.length) fail();
  const chains = new Set<string>();
  for (const list of value.activeLists) {
    if (chains.has(list.chain)) fail(); chains.add(list.chain);
    const found = lists.get(list.chain); if (!found || referenced(list.latestAttempt, result, expected).sequence !== found.latest.sequence) fail();
    if ((list.context?.sequence ?? null) !== (found.context?.sequence ?? null)) fail();
    if (list.context) referenced(list.context, result, expected);
  }
  return result;
}
function canonicalRef(value: ResearchAssetRef): ResearchAssetRef {
  const ref = assetRef(value.chain, value.assetId); if (ref.refId !== value.refId) fail(); return ref;
}
function selection(value: WorkingSetSelection | undefined, view: CanonicalView, expected: ResearchScope): ContextSelection | null {
  if (!value) return null;
  if (value.executionAuthority !== "not_authorized_by_report") fail();
  const available = new Set(view.records.flatMap((row) => {
    const request = workingSetRecordRequest(row);
    return request.kind === "market_brief" ? (market(row)?.candidates.map((item) => item.asset.refId) ?? []) : [assetRef(request.chain, request.assetId).refId];
  }));
  const ref = (asset: ResearchAssetRef): ResearchAssetRef => { const result = canonicalRef(asset); if (!available.has(result.refId)) fail(); return result; };
  if (value.kind === "unresolved") {
    if (!["no_active_list", "chain_ambiguous", "held", "not_found", "symbol_ambiguous", "metric_missing", "tie", "ordinal_out_of_range"].includes(value.reason)
      || !Array.isArray(value.options) || value.options.length > 24) fail();
    return { kind: "unresolved", reason: value.reason, options: value.options.map(ref) };
  }
  if (value.kind !== "resolved" || !Array.isArray(value.assets) || value.assets.length > 12) fail();
  let hold = false; const seen = new Set<string>();
  const assets = value.assets.map((item) => {
    const asset = ref(item.asset); if (seen.has(asset.refId)) fail(); seen.add(asset.refId);
    const list = view.active.find((row) => row.chain === asset.chain); const report = market(list?.context);
    const ordinal = report?.candidates.findIndex((row) => row.asset.refId === asset.refId) ?? -1;
    const exact = view.exact.filter((row) => { const request = workingSetRecordRequest(row);
      return request.kind !== "market_brief" && assetRef(request.chain, request.assetId).refId === asset.refId; });
    const candidate = exact.find((row) => workingSetRecordRequest(row).kind === "candidate_report");
    const risk = exact.find((row) => workingSetRecordRequest(row).kind === "risk_report");
    for (const [supplied, latest] of [[item.candidateReport, candidate], [item.riskReport, risk]] as const) {
      if ((supplied?.sequence ?? null) !== (latest?.sequence ?? null)) fail(); if (supplied) referenced(supplied, view, expected);
    }
    if (!!item.discovery !== (ordinal >= 0)) fail();
    if (item.discovery && (item.discovery.sequence !== list!.context!.sequence || item.discovery.ordinal !== ordinal + 1
      || canonicalRef(item.discovery.observation.asset).refId !== asset.refId)) fail();
    if (exact.some(held) || (!exact.length && (!list || held(list.latest)))) hold = true;
    return { asset, ...(ordinal < 0 ? {} : { discovery: { sequence: list!.context!.sequence, ordinal: ordinal + 1,
      contextOnly: item.discovery!.contextOnly || held(list!.latest) || held(list!.context!), assessment: assessment(list!.context!.assessment!),
      freshness: list!.context!.assessment!.candidates[ordinal]! } }),
      ...(candidate ? { candidateReportSequence: candidate.sequence } : {}), ...(risk ? { riskReportSequence: risk.sequence } : {}) };
  });
  return hold ? { kind: "unresolved", reason: "held", options: assets.map((item) => item.asset) } : { kind: "resolved", assets };
}

/** Current-time projection. Truncated facts remain marked; active ordinals are never removed or reordered. */
export function projectWorkingContext(input: WorkingContextInput): PrivateWorkingContext {
  try {
    const expected = scope(input.scope); if (!Number.isFinite(input.nowMs) || !Number.isFinite(new Date(input.nowMs).getTime())) fail();
    const view = canonicalView(input.view, expected, input.nowMs); const selected = selection(input.selection, view, expected);
    const selectedSequences = selected?.kind === "resolved" ? selected.assets.flatMap((row) => [row.candidateReportSequence, row.riskReportSequence].filter((value): value is number => value !== undefined)) : [];
    const priority = [...view.exact.filter((row) => selectedSequences.includes(row.sequence)), ...view.exact.filter((row) => !selectedSequences.includes(row.sequence))];
    const briefCount = view.records.filter((row) => workingSetRecordRequest(row).kind === "market_brief").length;
    const retainedBriefs = new Set(view.active.flatMap((row) => [row.latest.sequence, ...(row.context ? [row.context.sequence] : [])]));
    const base = (compact: boolean): PrivateWorkingContext => ({ version: 1, scope: expected, assessedAt: new Date(input.nowMs).toISOString(),
      executionAuthority: "not_authorized_by_report", activeLists: view.active.map((row) => active(row, compact)),
      exactReports: priority.filter((row) => selectedSequences.includes(row.sequence)).map((row) => exactReport(row, false)), selection: selected,
      truncation: { maximumBytes: MAX_WORKING_CONTEXT_BYTES, listDetail: compact ? "compact" : "full", sourceRecords: view.records.length,
        latestExactReports: view.exact.length, omittedExactReports: view.exact.length - new Set(selectedSequences).size,
        supersededExactReports: view.records.length - briefCount - view.exact.length, historicalBriefReports: briefCount - retainedBriefs.size, ...(view.retention ? { retention: view.retention } : {}) } });
    let result = base(false); const size = (value: PrivateWorkingContext): number => Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size(result) > MAX_WORKING_CONTEXT_BYTES) result = base(true);
    if (size(result) > MAX_WORKING_CONTEXT_BYTES) fail();
    for (const row of priority) {
      const previous = result.exactReports.findIndex((item) => item.sequence === row.sequence);
      const reports = [...result.exactReports]; const next = exactReport(row, true);
      if (previous >= 0) reports[previous] = next; else reports.push(next);
      const candidate = { ...result, exactReports: reports, truncation: { ...result.truncation, omittedExactReports: view.exact.length - reports.length } };
      if (size(candidate) <= MAX_WORKING_CONTEXT_BYTES) result = candidate;
    }
    return freeze(result);
  } catch (error: unknown) { if (error instanceof PrivateWorkingContextError) throw error; return fail(); }
}
/** Only accepts source inputs; arbitrary objects cannot be serialized through this boundary. */
export function renderWorkingContext(input: WorkingContextInput): string { return JSON.stringify(projectWorkingContext(input)); }
