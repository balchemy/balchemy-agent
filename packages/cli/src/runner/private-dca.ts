/** K1b DCA (compiler 1.3.0 `dca`, feature dca.v1): the pure trigger, cap and gate decision of one DCA add, its plan digest and its
 * evidence binding. The durable campaign and add records live in private-dca-store.ts, the worker in private-dca-worker.ts and the
 * build in private-dca-build.ts. Whether a runner executes DCA at all is decided by PRIVATE_RULE_SUPPORTED_FEATURES
 * (private-typed-rules.ts): without dca.v1 a revision with `dca` has no execution policy, so nothing here is ever reached.
 *
 * The campaign (owner decision of 19 Nov 2026, the advisor plan):
 * - one per mint, durable; its spend is MONOTONIC: the opening holding's cost plus every add once signed, never refunded when a
 *   lot is sold (a stop-loss no longer frees maxTotal), and the adds still in flight count against maxTotal as pending;
 * - its last-buy reference is the newest buy EVER made in the campaign (never an older lot after a newer one closed);
 * - it ends for good on any stop-loss or trailing-stop exit of the mint (adds stop permanently on that mint), and ends
 *   restartably when the holding is gone;
 * - at most PRIVATE_DCA_MAX_LOTS_PER_MINT adds per campaign; unmanaged or outside mints never get one.
 * Every amount is in base units (lamports) and BigInt only. Every other execution gate (choke point, entry hold, owner approval and
 * ceiling, pre-trade, fee policy, simulation, the server's position gate) stays the execution path's. */
import { createHash } from "node:crypto";
import type { BehaviorRules } from "@balchemyai/agent-rules";
import type { RunnerAgentState, RunnerDcaStatus } from "./protocol.js";
import { parsePrivateSolAmount } from "./private-sizing.js";
import { privateAvoidOutcome, privateTokenBuyCount, type PrivateAvoidFacts } from "./private-typed-rules.js";
import type { PrivateExitSnapshot } from "./private-exit-triggers.js";
import type { PrivateResearchMarketFacts, ResearchScope } from "./private-research-evidence.js";
import { validateWorkingSetRecord, type WorkingSetSelection } from "./private-working-set.js";

/** Adds per campaign (per mint). The engine's own bound (448 records, dca_record_headroom) is far above it. */
export const PRIVATE_DCA_MAX_LOTS_PER_MINT = 8;
/** The evidence an add binds must stay fresh at least this long (the build, the 90 s signing window and the relay fit in it). */
export const PRIVATE_DCA_EVIDENCE_MIN_FRESH_MS = 5 * 60_000;
/** The dip trigger reads the exit worker's last valuation of the mint only while it is at most this old. */
export const PRIVATE_DCA_VALUATION_MAX_AGE_MS = 60_000;

export interface PrivateDcaCampaignView {
  /** Monotonic lamports of the campaign (see the module comment). */
  spentLamports: bigint;
  /** Lamports of adds started and not signed yet: they count against maxTotal, never against spentLamports. */
  pendingLamports: bigint;
  /** Adds signed in this campaign. */
  lots: number;
  /** The newest buy ever made in the campaign; units are null until that buy's lot opened. */
  lastBuy: { at: number; units: bigint | null; costLamports: bigint };
  ended: boolean;
}
export interface PrivateDcaInput {
  rules: BehaviorRules; runtime: Pick<RunnerAgentState, "mode" | "lifecycle" | "armed" | "entries">; nowMs: number;
  mint: string; avoid: PrivateAvoidFacts; campaign: PrivateDcaCampaignView | null; buysOfToken: number | null;
  /** The owner's spend caps in lamports: null is an explicit "no limit"; `unset` caps never reach here (limits_missing). */
  perTradeCapLamports: bigint | null; dailyRemainingLamports: bigint | null;
  /** The freshest net valuation of `units` of the mint (the exit worker's, never a separate quote): lamports out. Absent: the dip
   * trigger cannot fire. The value is net of the platform fee while the last buy's cost is gross, so a dip below about the fee
   * rate fires on the first valuation. */
  quote?: { units: bigint; outLamports: bigint };
}
export const PRIVATE_DCA_REFUSALS = ["dca_not_configured", "dca_other_mint", "runtime_disallowed", "no_holding", "not_due", "dca_cap_reached",
  "spend_cap", "avoid_listed", "rule_fact_unknown", "token_buy_limit", "amount_invalid", "quote_missing", "dca_campaign_ended", "dca_lot_cap"] as const;
export type PrivateDcaRefusal = typeof PRIVATE_DCA_REFUSALS[number];
export type PrivateDcaDecision = { due: true; amountLamports: bigint; trigger: "interval" | "dip" } | { due: false; reason: PrivateDcaRefusal };

export function privateDcaDecision(input: PrivateDcaInput): PrivateDcaDecision {
  const dca = input.rules.dca;
  const no = (reason: PrivateDcaRefusal): PrivateDcaDecision => ({ due: false, reason });
  if (!dca || dca.unit !== "SOL") return no("dca_not_configured");
  if (dca.mint !== undefined && dca.mint !== input.mint) return no("dca_other_mint");
  // Never while paused, disarmed, stopped or with new entries held: a DCA add is an entry.
  if (input.runtime.mode !== "live_armed" || !input.runtime.armed || input.runtime.lifecycle !== "idle" || input.runtime.entries !== "enabled") return no("runtime_disallowed");
  const avoid = privateAvoidOutcome(input.rules, input.avoid);
  if (avoid === "listed") return no("avoid_listed");
  if (avoid === "unknown") return no("rule_fact_unknown");
  const campaign = input.campaign;
  if (!campaign || campaign.spentLamports <= 0n) return no("no_holding");
  if (campaign.ended) return no("dca_campaign_ended");
  if (campaign.lots >= PRIVATE_DCA_MAX_LOTS_PER_MINT) return no("dca_lot_cap");
  let amount: bigint; let cap: bigint;
  try { amount = BigInt(parsePrivateSolAmount(dca.amount).amountBaseUnits); cap = BigInt(parsePrivateSolAmount(dca.maxTotal).amountBaseUnits); }
  catch { return no("amount_invalid"); }
  if (amount <= 0n) return no("amount_invalid");
  if (input.rules.risk.maxBuysPerToken !== undefined) {
    if (input.buysOfToken === null) return no("rule_fact_unknown");
    if (input.buysOfToken >= input.rules.risk.maxBuysPerToken) return no("token_buy_limit");
  }
  if (campaign.spentLamports + campaign.pendingLamports + amount > cap) return no("dca_cap_reached");
  if ((input.perTradeCapLamports !== null && amount > input.perTradeCapLamports)
    || (input.dailyRemainingLamports !== null && amount > input.dailyRemainingLamports)) return no("spend_cap");
  const last = campaign.lastBuy;
  if (dca.trigger.kind === "interval") {
    if (!Number.isFinite(input.nowMs) || input.nowMs < last.at || input.nowMs - last.at < dca.trigger.intervalMs) return no("not_due");
    return { due: true, amountLamports: amount, trigger: "interval" };
  }
  const quote = input.quote;
  if (!quote || quote.units <= 0n || last.units === null || last.units <= 0n || last.costLamports <= 0n) return no("quote_missing");
  // price_now <= price_last * (1 - dip): out/unitsQ <= cost/units * (10000 - dipBps)/10000, in integers.
  const dipBps = BigInt(Math.round(dca.trigger.dipPct * 100));
  if (dipBps <= 0n || dipBps >= 10_000n) return no("amount_invalid");
  const dipped = quote.outLamports * last.units * 10_000n <= last.costLamports * quote.units * (10_000n - dipBps);
  return dipped ? { due: true, amountLamports: amount, trigger: "dip" } : no("not_due");
}
/** The buy count the DCA gate reads (same holding rule as max_buys_per_token.v1). */
export const privateDcaBuysOfToken = privateTokenBuyCount;

/** The fields one add's plan digest binds (all of them are stored in its durable record). */
export interface PrivateDcaPlanFields {
  localProfileId: string; agentId: string; reservationId: string; mint: string; walletAddress: string; parentEntryBuildDigest: string;
  amountLamports: string; slippageBps: number; ruleRevisionId: string; rulesDigest: string; exit: PrivateExitSnapshot;
  trigger: "interval" | "dip"; runtimeVersion: number; createdAt: number;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
/** 64 lowercase hex: the add's plan digest (the request's planDigest and dca.dcaPlanDigest, and the lot's entry plan digest). */
export function privateDcaPlanDigest(fields: PrivateDcaPlanFields): string {
  return createHash("sha256").update(canonical(["balchemy.private-dca-plan.v1", fields.localProfileId, fields.agentId, fields.reservationId,
    fields.mint, fields.walletAddress, fields.parentEntryBuildDigest, fields.amountLamports, fields.slippageBps, fields.ruleRevisionId,
    fields.rulesDigest, fields.exit, fields.trigger, fields.runtimeVersion, fields.createdAt]), "utf8").digest("hex");
}
/** The spend-ledger jobId of an add's reservation (an isId value no signal job can take). */
export function privateDcaJobId(planDigest: string): string { return `dca:${planDigest}`; }

/** One evidence binding of an add (the request's `evidence` item). */
export interface PrivateDcaEvidence { kind: "candidate_report" | "risk_report"; serverEvidenceId: string; snapshotDigest: string; staleAt: string }
/** What one bound report says that the add's own entry rules read (the signal path's facts, private-outer-decision.ts): its reported
 * market numbers (the typed entry filters), its symbol (the never-buy list) and its reported risk verdict (trimmed, lower case; the
 * legacy risk-verdict conditions). Local only: never part of the build request. */
export interface PrivateDcaReportFacts { market: PrivateResearchMarketFacts | undefined; symbol: string | null; verdict: string }
export type PrivateDcaEvidenceResult = { ok: true; evidence: PrivateDcaEvidence[]; reports: PrivateDcaReportFacts[] }
  | { ok: false; reason: "evidence_missing" | "evidence_stale" | "evidence_mismatch" };
/** The usable research of exactly `mint` in a working-set selection (the signal path's rule, private-outer-decision.ts): every report
 * present must be usable research with a server evidence id, and each must stay fresh for at least `minFreshMs`. `reports` carries each
 * bound report's facts, in the same order. */
export function privateDcaEvidence(selection: WorkingSetSelection, scope: ResearchScope, mint: string, nowMs: number,
  minFreshMs: number = PRIVATE_DCA_EVIDENCE_MIN_FRESH_MS): PrivateDcaEvidenceResult {
  if (selection.kind !== "resolved") return { ok: false, reason: "evidence_missing" };
  if (selection.assets.length !== 1) return { ok: false, reason: "evidence_mismatch" };
  const selected = selection.assets[0]!;
  if (selected.asset.chain !== "solana" || selected.asset.assetId !== mint) return { ok: false, reason: "evidence_mismatch" };
  const evidence: PrivateDcaEvidence[] = []; const reports: PrivateDcaReportFacts[] = [];
  for (const key of ["candidateReport", "riskReport"] as const) {
    const supplied = selected[key]; if (!supplied) continue;
    let record: ReturnType<typeof validateWorkingSetRecord>;
    try { record = validateWorkingSetRecord(supplied, scope, nowMs); } catch { return { ok: false, reason: "evidence_mismatch" }; }
    if (record.evidence.kind !== "report") return { ok: false, reason: "evidence_stale" };
    const report = record.evidence.report;
    if (report.kind === "market_brief" || report.kind !== (key === "candidateReport" ? "candidate_report" : "risk_report") || report.asset.chain !== "solana"
      || report.asset.assetId !== mint) return { ok: false, reason: "evidence_mismatch" };
    const assessment = record.assessment;
    if (assessment?.state !== "usable_research" || !assessment.staleAt || !report.serverEvidenceId) return { ok: false, reason: "evidence_stale" };
    if (!(Date.parse(assessment.staleAt) - nowMs >= minFreshMs)) return { ok: false, reason: "evidence_stale" };
    evidence.push({ kind: report.kind, serverEvidenceId: report.serverEvidenceId, snapshotDigest: record.evidence.snapshot.snapshotDigest,
      staleAt: assessment.staleAt });
    reports.push({ market: report.market === undefined ? undefined : { ...report.market }, symbol: report.symbol,
      verdict: report.risk.reportedVerdict.trim().toLowerCase() });
  }
  return evidence.length ? { ok: true, evidence, reports } : { ok: false, reason: "evidence_missing" };
}

/** Plain words for the DCA worker's closed reasons (the status line); any other code is shown as its words. */
const DCA_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "rule_fact_unknown:symbol": "symbol facts unknown", "rule_fact_unknown:creator": "creator facts unknown (a creator never-buy entry holds every add)",
  rule_fact_unknown: "a fact your rules need is unknown", rule_avoid_listed: "the token is on your never-buy list", avoid_listed: "the token is on your never-buy list",
  entry_facts_missing: "facts your entry rules need are missing", entry_rule_failed: "an entry rule failed",
  max_positions_unknown: "positions could not be counted", not_due: "next add not due yet", dca_cap_reached: "the DCA total is reached",
  dca_lot_cap: "the most adds per token are made", dca_campaign_ended: "DCA ended for this token after a stop-loss or trailing stop",
  dca_no_holding: "no open position to add to", no_holding: "no open position to add to", dca_mint_unmanaged: "the token is not managed by the agent",
  dca_exit_pending: "a sell of the token is in progress", dca_add_unsettled: "the last add is still settling", evidence_missing: "no fresh research",
  evidence_stale: "the research is out of date", evidence_mismatch: "the research did not match the token", runtime_disallowed: "the agent is not armed or new buys are paused",
  limits_missing: "spend limits are not set", dca_daily_cap_required: "a daily spend cap in SOL is needed", spend_cap: "a spend limit is reached",
  keystore_locked: "the trading wallet is locked", wallet_missing: "no trading wallet", arm_unconfirmed: "Balchemy has not confirmed the arm yet",
  rate_limited: "waiting for the one-buy-per-30-seconds guard", intent_running: "another buy is running", token_buy_limit: "the per-token buy limit is reached",
  watermark_missing: "positions are not set up yet", dca_rules_unbindable: "the confirmed rules cannot be bound to an add", dca_unavailable: "the DCA records could not be read", dca_recovery_pending: "an interrupted add is being resolved",
});
function dcaReasonText(reason: string): string {
  if (Object.hasOwn(DCA_REASON_TEXT, reason)) return DCA_REASON_TEXT[reason]!;
  const limit = /^max_positions:([1-9][0-9]{0,3})$/.exec(reason);
  if (limit) return `max ${limit[1]} positions reached`;
  return reason.replace(/[_:]+/g, " ");
}
const shortMint = (mint: string): string => `${mint.slice(0, 4)}…${mint.slice(-4)}`;
/** One short owner line for an agent's DCA status, or null when DCA is not configured for it. */
export function formatPrivateDcaStatus(status: RunnerDcaStatus): string | null {
  if (status.reason === "dca_not_configured" && status.holds.length === 0) return null;
  const hold = status.holds[0];
  if (hold) return `DCA: waiting — ${dcaReasonText(hold.reason)} for ${shortMint(hold.mint)}${status.holds.length > 1 ? ` (+${status.holds.length - 1} more)` : ""}`;
  if (status.reason === null) return "DCA: on, no add waiting";
  return `DCA: waiting — ${dcaReasonText(status.reason)}`;
}
