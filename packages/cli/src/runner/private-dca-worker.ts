/** K1b DCA worker: one add at most per drain of the execution worker (private-execution-intents.ts runs it inside its per-agent drain,
 * after the signal queue, so an add and a signal buy never overlap and share every gate):
 * 0. Reconcile the durable records (private-dca-store.ts) from the journal, the spend ledger and the position ledger: a held add with a
 *    journal attempt is submitted, one whose reservation is released or gone is refused; a submitted add is opened once its lot exists,
 *    not_landed once its buy is proven not landed; a campaign ends for good once any position of its mint started a stop-loss or
 *    trailing-stop exit, and restartably once its holding is gone.
 * 1. Candidates: the confirmed revision's `dca` (only reached when this runner declares dca.v1: otherwise the revision has no execution
 *    policy and readRules answers null), each managed mint with open positions only (no held position, no pending exit; unmanaged and
 *    outside mints never), its campaign folded from its opening buys, then privateDcaDecision (interval, or the dip against the exit
 *    worker's own last valuation: no extra sell assessment, the stop-loss's assessment budget is shared).
 *    A DCA lot is never folded as an opening buy: it is recognised by its add record (kept while its lot is not closed) or by its spend
 *    reservation's `dca:` jobId.
 * 2. The signal buy's gates (PrivateExecutionSharedGates): the entry choke point, the S5c entry hold, the owner's max positions (an add
 *    of a held mint never adds to the count), limits, RPC class, wallet holds, the keystore, one running start per agent and the
 *    per-wallet rate guard across signal intents and adds, Balchemy's armed mirror; then the typed rules (never-buy mints, per-token
 *    buys, trades per day) and a daily cap that is an amount.
 * 3. Fresh research evidence of the mint (network read only), then the signal buy's entry rules on that evidence: the never-buy list with
 *    the reports' symbol (two different reported symbols, or a creator list, are unknown: no add), the typed entry filters (the reports'
 *    market numbers and, when a rule needs them, top-holder shares from the entry RPC) and the legacy chain / risk-verdict conditions
 *    (private-outer-decision.ts; entry signal checks belong to a signal and do not apply to an add). Unknown or failing: no add, the mint
 *    backs off (growing) with the reason in the worker status. Then re-checks, and the add is written `running` with a fresh reservationId
 *    BEFORE any reservation or network call that could spend; built (private-dca-build.ts) and submitted through PrivateSubmissions.submit
 *    with an expiry that refuses the signature once an exit of the mint started, the parent lot is no longer open, the campaign ended or
 *    the evidence went stale (withhold an unsent add on exit). Never rebuilt: a released add is retried only as a NEW add with fresh
 *    evidence and a new reservationId, after its predecessor is settled.
 * Server refusals: dca_spacing, dca_position_pending and local_swap_busy wait a short back-off; dca_parent_mismatch,
 * dca_daily_cap_required and dca_record_headroom hold the mint until its parent lot or the rule head changes; dca_position_empty holds it
 * until the holding changes. */
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { BehaviorRuleEngine, isTypedEntryCondition, type BehaviorRules } from "@balchemyai/agent-rules";
import type { PrivateExecutionBuildOutcome } from "./private-execution-build.js";
import type { PrivateExecutionGatePlan } from "./private-execution-gate.js";
import type { PrivateExecutionDcaStep, PrivateExecutionSharedGates } from "./private-execution-intents.js";
import type { PrivateExitSnapshot } from "./private-exit-triggers.js";
import { privateUnmanagedMints, type PrivatePosition, type PrivatePositionManagedFrom } from "./private-positions.js";
import type { PrivateSpendLedger } from "./private-spend-ledger.js";
import type { PrivateSubmissionOutcome, PrivateValidatedExecution } from "./private-submission.js";
import type { PrivateSubmissionAttempt } from "./private-submission-journal.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import type { RunnerAgentState } from "./protocol.js";
import { privateAvoidRefusal, privateDailyTradeCount, privateEntryFacts, privateEntryRuleRefusal, privateTokenBuyCount, privateTopHolderCounts,
  privateTypedEntryOutcome, privateWithEntryFacts, type PrivateMaxPositions } from "./private-typed-rules.js";
import type { PrivateHolderShares } from "./private-holder-share.js";
import { privateDcaDecision, privateDcaPlanDigest, PRIVATE_DCA_VALUATION_MAX_AGE_MS, type PrivateDcaCampaignView, type PrivateDcaEvidence,
  type PrivateDcaEvidenceResult, type PrivateDcaReportFacts } from "./private-dca.js";
import { privateDcaAddUnsettled, type PrivateDcaAdd, type PrivateDcaAddChange, type PrivateDcaCampaign,
  type PrivateDcaStore } from "./private-dca-store.js";
import type { PrivateDcaBuildInput } from "./private-dca-build.js";

export const PRIVATE_DCA_POLL_MS = 15_000;
/** Back-off of a mint after a transient refusal (spacing, a pending engine record, a busy swap lock, missing evidence). */
export const PRIVATE_DCA_RETRY_MS = 60_000;
/** Hold of a mint after a refusal that only a change of facts lifts (still re-read at most this often). */
export const PRIVATE_DCA_HOLD_MS = 600_000;
const TRANSIENT_SERVER: readonly string[] = ["dca_spacing", "dca_position_pending", "local_swap_busy", "wallet_busy"];
const HOLD_SERVER: readonly string[] = ["dca_parent_mismatch", "dca_daily_cap_required", "dca_record_headroom", "dca_position_empty"];
const PROTECTIVE: readonly string[] = ["stop_loss", "trailing_stop"];
const code = (text: string): string => text.replace(/[^a-z0-9_:]/g, "_").slice(0, 96) || "refused";
const RULE_REVISION = /^brr_[0-9a-f]{64}$/;
const DCA_JOB = /^dca:/;
const engine = new BehaviorRuleEngine();
/** The rules with only the never-buy MINT list: the candidate scan runs before any evidence (symbol) exists; the full list is checked on
 * the evidence (#entryRules). */
function mintOnlyAvoid(rules: BehaviorRules): BehaviorRules {
  return rules.avoid ? { ...rules, avoid: { ...rules.avoid, symbols: [], creators: [] } } : rules;
}

/** The confirmed revision's DCA facts (null when the revision has no execution policy here, or no `dca`). */
export interface PrivateDcaRules {
  revisionId: string; rulesDigest: string; rules: BehaviorRules; exit: PrivateExitSnapshot; risks: PrivateExecutionGatePlan["risks"];
  /** The owner's max positions of this revision (privateStatedMaxPositions): N when the rules state it, `"none"` when they never did,
   * null when that cannot be told (the shared gate refuses max_positions_unknown). */
  maxPositions: PrivateMaxPositions | null;
}
/** The exit worker's last valuation of one position (net of the platform fee). */
export interface PrivateDcaValuation { units: string; valueLamports: string; observedAtMs: number }
export interface PrivateDcaWorkerOptions {
  localProfileId: string;
  store: Pick<PrivateDcaStore, "read" | "fold" | "end" | "begin" | "update">;
  readRules(agentId: string): PrivateDcaRules | null;
  readRuntime(agentId: string): RunnerAgentState | undefined;
  readWallet(agentId: string): TradingWalletStatus;
  readPositions(agentId: string): readonly PrivatePosition[];
  readManagedFrom(agentId: string): PrivatePositionManagedFrom | null;
  readEvicted(agentId: string): readonly string[];
  readAttempts(agentId: string): readonly PrivateSubmissionAttempt[];
  readEvictedRecentAt(agentId: string): number | null;
  ledger: Pick<PrivateSpendLedger, "status" | "reservation">;
  readValuation(agentId: string, positionId: string): PrivateDcaValuation | undefined;
  /** True while a triggered sell of the mint waits for the wallet (the exit worker's deferred sell): no add of the mint may go first. */
  readExitWanted?(agentId: string, mint: string): boolean;
  /** Fresh usable research of the mint (the working set, refreshed with one research query when stale); a throw is unavailable. */
  readEvidence(agentId: string, mint: string, signal: AbortSignal): Promise<PrivateDcaEvidenceResult>;
  /** Top-N holder shares of the mint (readPrivateHolderShares over the entry RPC), read only when a typed rule needs them. Absent or
   * failing: every such fact is unknown, so a top-holder filter holds the add. */
  readHolderShares?(agentId: string, mint: string, counts: readonly number[], signal: AbortSignal): Promise<PrivateHolderShares>;
  build(agentId: string, input: PrivateDcaBuildInput, signal: AbortSignal): Promise<PrivateExecutionBuildOutcome>;
  submit(agentId: string, built: PrivateValidatedExecution, signal: AbortSignal, expiry: () => string | null): Promise<PrivateSubmissionOutcome>;
  now?(): number; monotonicNow?(): number; pollMs?: number;
}
export interface PrivateDcaWorkerStatus { reason: string | null; holds: ReadonlyArray<{ mint: string; reason: string }> }
interface Hold { reason: string; key: string; untilMs: number }
interface Candidate { mint: string; parent: PrivatePosition; amountLamports: bigint; trigger: "interval" | "dip"; campaign: PrivateDcaCampaign }

export class PrivateDcaWorker implements PrivateExecutionDcaStep {
  readonly #options: PrivateDcaWorkerOptions;
  readonly #recovered = new Set<string>();
  readonly #holds = new Map<string, Map<string, Hold>>();
  readonly #reasons = new Map<string, string | null>();
  /** Consecutive refused adds per agent and mint (with the parent and rule head they were refused under); reset by a signed add. */
  readonly #refusals = new Map<string, { key: string; count: number }>();
  constructor(options: PrivateDcaWorkerOptions) { this.#options = options; }
  get pollMs(): number { return this.#options.pollMs ?? PRIVATE_DCA_POLL_MS; }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #monotonic(): number { return (this.#options.monotonicNow ?? (() => performance.now()))(); }
  status(agentId: string): PrivateDcaWorkerStatus {
    return { reason: this.#reasons.get(agentId) ?? null, holds: [...(this.#holds.get(agentId) ?? new Map<string, Hold>())]
      .filter(([, hold]) => this.#monotonic() < hold.untilMs).map(([mint, hold]) => ({ mint, reason: hold.reason })) };
  }
  #note(agentId: string, reason: string | null): void { this.#reasons.set(agentId, reason === null ? null : code(reason)); }

  /** Resolves interrupted `running` adds from the journal only (never rebuilt). True once none is left. */
  recover(agentId: string): boolean {
    if (this.#recovered.has(agentId)) return true;
    const o = this.#options;
    try {
      const attempts = o.readAttempts(agentId);
      for (const add of o.store.read(agentId).adds.filter((item) => item.state === "running")) {
        const attempt = attempts.find((item) => item.reservationId === add.reservationId);
        o.store.update(agentId, add.reservationId, "running", attempt ? { state: "submitted", attemptKey: attempt.attemptKey, reason: "recovered" }
          : { state: "refused", reason: "interrupted" }, this.#now());
      }
      this.#recovered.add(agentId); return true;
    } catch { return false; }
  }
  /** Every add's start (the shared rate guard and single-running rule); a throw refuses the caller's start. */
  starts(agentId: string): readonly { walletAddress: string; startedAt: number; running: boolean }[] {
    return this.#options.store.read(agentId).adds.map((item) => ({ walletAddress: item.walletAddress, startedAt: item.createdAt, running: item.state === "running" }));
  }
  /** True while an add of the agent is running (the exit worker's sell hold, like a running signal intent). */
  running(agentId: string): boolean { return this.#options.store.read(agentId).adds.some((item) => item.state === "running"); }

  /** Step 0 (synchronous, never throws). */
  #reconcile(agentId: string): void {
    const o = this.#options;
    let adds: readonly PrivateDcaAdd[]; let campaigns: readonly PrivateDcaCampaign[];
    let attempts: readonly PrivateSubmissionAttempt[]; let positions: readonly PrivatePosition[]; let evicted: ReadonlySet<string>;
    try {
      ({ adds, campaigns } = o.store.read(agentId)); attempts = o.readAttempts(agentId); positions = o.readPositions(agentId);
      evicted = new Set(o.readEvicted(agentId));
    } catch { return; }
    const now = this.#now();
    const update = (add: PrivateDcaAdd, change: PrivateDcaAddChange): void => {
      try { o.store.update(agentId, add.reservationId, add.state, change, now); } catch { /* Re-checked at the next step. */ }
    };
    for (const add of adds) {
      const attempt = attempts.find((item) => item.reservationId === add.reservationId);
      if (add.state === "held") {
        if (attempt) { update(add, { state: "submitted", attemptKey: attempt.attemptKey, reason: "reconciled" }); continue; }
        let reservation: ReturnType<PrivateDcaWorkerOptions["ledger"]["reservation"]>;
        try { reservation = o.ledger.reservation(agentId, add.reservationId); } catch { continue; }
        if (!reservation || reservation.state === "released") update(add, { state: "refused", reason: "held_released" });
      } else if (add.state === "submitted") {
        const lot = positions.find((item) => item.entry.reservationId === add.reservationId);
        if (lot) update(add, { state: "opened", units: lot.entry.units });
        else if (attempt && (attempt.state === "failed_onchain" || attempt.state === "expired_not_landed" || attempt.state === "closed_by_owner")) {
          update(add, { state: "not_landed", reason: attempt.state });
        } else if (!attempt && evicted.has(add.reservationId)) update(add, { state: "opened", units: "0" });
      }
    }
    let current: readonly PrivateDcaAdd[];
    try { current = o.store.read(agentId).adds; } catch { return; }
    for (const campaign of campaigns) {
      if (campaign.endReason !== null) continue;
      const ofMint = positions.filter((item) => item.tokenMint === campaign.mint);
      const protective = ofMint.flatMap((item) => [
        ...(item.pendingExit && PROTECTIVE.includes(item.pendingExit.trigger) && item.pendingExit.createdAt >= campaign.startedAt ? [item.pendingExit.trigger] : []),
        ...item.exits.filter((exit) => PROTECTIVE.includes(exit.trigger) && exit.completedAt >= campaign.startedAt).map((exit) => exit.trigger)])[0];
      try {
        if (protective === "stop_loss" || protective === "trailing_stop") o.store.end(agentId, campaign.mint, protective, now);
        else if (!ofMint.some((item) => item.state !== "closed") && !current.some((item) => item.mint === campaign.mint && privateDcaAddUnsettled(item))) {
          o.store.end(agentId, campaign.mint, "holding_closed", now);
        }
      } catch { /* Re-checked at the next step. */ }
    }
  }

  /** The add's own gates, re-checked before the reservation, after the build exchange and right before the signature. */
  #addRefusal(agentId: string, add: Pick<PrivateDcaAdd, "reservationId" | "mint" | "parentEntryBuildDigest">, expectRunning: boolean): string | null {
    const o = this.#options;
    const positions = o.readPositions(agentId);
    const ofMint = positions.filter((item) => item.tokenMint === add.mint && item.state !== "closed");
    if (ofMint.some((item) => item.pendingExit !== null) || o.readExitWanted?.(agentId, add.mint) === true) return "dca_exit_pending";
    if (ofMint.some((item) => item.state === "held")) return "dca_position_held";
    const parent = ofMint.find((item) => item.entry.buildDigest === add.parentEntryBuildDigest);
    if (!parent || parent.state !== "open") return "dca_parent_closed";
    const { campaigns, adds } = o.store.read(agentId);
    const campaign = campaigns.find((item) => item.mint === add.mint);
    if (!campaign || campaign.endReason !== null) return "dca_campaign_ended";
    if (expectRunning && adds.find((item) => item.reservationId === add.reservationId)?.state !== "running") return "dca_add_changed";
    return null;
  }
  #held(agentId: string, mint: string, key: string): boolean {
    const hold = this.#holds.get(agentId)?.get(mint);
    if (!hold) return false;
    if (this.#monotonic() >= hold.untilMs || hold.key !== key) { this.#holds.get(agentId)?.delete(mint); return false; }
    return true;
  }
  #hold(agentId: string, mint: string, reason: string, key: string, ms: number): void {
    let holds = this.#holds.get(agentId); if (!holds) { holds = new Map(); this.#holds.set(agentId, holds); }
    holds.set(mint, { reason: code(reason), key, untilMs: this.#monotonic() + ms });
  }
  #view(campaign: PrivateDcaCampaign, adds: readonly PrivateDcaAdd[]): PrivateDcaCampaignView {
    const pending = adds.filter((item) => item.mint === campaign.mint && (item.state === "running" || item.state === "held"))
      .reduce((sum, item) => sum + BigInt(item.amountLamports), 0n);
    return { spentLamports: BigInt(campaign.spentLamports), pendingLamports: pending, lots: campaign.lots, ended: campaign.endReason !== null,
      lastBuy: { at: campaign.lastBuy.at, units: campaign.lastBuy.units === null ? null : BigInt(campaign.lastBuy.units), costLamports: BigInt(campaign.lastBuy.costLamports) } };
  }

  /** One drain's DCA work for the agent. Never throws. */
  async step(agentId: string, gates: PrivateExecutionSharedGates, signal: AbortSignal): Promise<void> {
    try { await this.#step(agentId, gates, signal); } catch { this.#note(agentId, "dca_unavailable"); }
  }
  async #step(agentId: string, gates: PrivateExecutionSharedGates, signal: AbortSignal): Promise<void> {
    const o = this.#options;
    if (!this.recover(agentId)) { this.#note(agentId, "dca_recovery_pending"); return; }
    this.#reconcile(agentId);
    const rules = o.readRules(agentId);
    const dca = rules?.rules.dca;
    if (!rules || !dca) { this.#note(agentId, "dca_not_configured"); return; }
    if (!RULE_REVISION.test(rules.revisionId) || !/^[0-9a-f]{64}$/.test(rules.rulesDigest)) { this.#note(agentId, "dca_rules_unbindable"); return; }
    const runtime = o.readRuntime(agentId);
    if (!runtime || runtime.mode !== "live_armed" || !runtime.armed || runtime.lifecycle !== "idle" || runtime.entries !== "enabled") {
      this.#note(agentId, "runtime_disallowed"); return;
    }
    const candidate = this.#candidate(agentId, rules, runtime);
    if (typeof candidate === "string") { this.#note(agentId, candidate); return; }
    const gatePlan: PrivateExecutionGatePlan = { runtimeVersion: runtime.version, ruleRevisionId: rules.revisionId, risks: rules.risks,
      exit: { stopLossBps: rules.exit.stopLossBps } };
    const now = this.#now();
    const buy = { mint: candidate.mint, maxPositions: rules.maxPositions };
    const entry = gates.entry(gatePlan, buy, now);
    if (entry) { this.#note(agentId, entry); return; }
    const wallet = o.readWallet(agentId);
    if (wallet.state !== "unlocked" || !wallet.addressVerified) { this.#note(agentId, wallet.state === "absent" ? "wallet_missing" : "keystore_locked"); return; }
    const start = gates.start(wallet.address, now);
    if (start) { this.#note(agentId, start); return; }
    if (!gates.armedSynced()) { this.#note(agentId, "arm_unconfirmed"); return; }
    const limits = o.ledger.status(agentId, now).limits;
    if (limits.daily.kind !== "lamports") { this.#note(agentId, "dca_daily_cap_required"); return; }
    const key = `${candidate.parent.entry.buildDigest}:${rules.revisionId}`;
    const evidence = await o.readEvidence(agentId, candidate.mint, signal).catch((): PrivateDcaEvidenceResult => ({ ok: false, reason: "evidence_missing" }));
    if (signal.aborted) return;
    if (!evidence.ok) { this.#hold(agentId, candidate.mint, evidence.reason, key, PRIVATE_DCA_RETRY_MS); this.#note(agentId, evidence.reason); return; }
    const refused = await this.#entryRules(agentId, rules.rules, candidate.mint, evidence.reports, signal);
    if (signal.aborted) return;
    if (refused) { this.#hold(agentId, candidate.mint, refused, key, this.#backoff(agentId, candidate.mint, key)); this.#note(agentId, refused); return; }
    await this.#run(agentId, candidate, rules, runtime, wallet.address, evidence.evidence, gates, gatePlan, signal);
  }
  /** The signal buy's entry rules on the add's fresh evidence (see step 3 of the module comment); null passes. Never throws except on
   * cancellation. */
  async #entryRules(agentId: string, rules: BehaviorRules, mint: string, reports: readonly PrivateDcaReportFacts[], signal: AbortSignal): Promise<string | null> {
    if (reports.length === 0) return "entry_facts_missing";
    const symbols = new Set(reports.map((item) => item.symbol));
    const symbol = symbols.size === 1 ? [...symbols][0] ?? null : null;
    // No creator fact exists yet: a creator list holds every add, like every signal buy; the reason names the missing fact.
    const avoid = privateAvoidRefusal(rules, { mint, symbol, creator: null });
    if (avoid) return avoid;
    if (rules.entry.conditions.some((condition) => !isTypedEntryCondition(condition) && !["chain", "risk_verdict", "risk.verdict"].includes(condition.field))) {
      return "entry_facts_missing";
    }
    const counts = privateTopHolderCounts(rules);
    let holders: PrivateHolderShares = {};
    if (counts.length && this.#options.readHolderShares) {
      try { holders = await this.#options.readHolderShares(agentId, mint, counts, signal); } catch { holders = {}; }
    }
    const facts = privateEntryFacts(rules, reports.map((item) => item.market), holders);
    const typed = privateTypedEntryOutcome(rules, facts);
    if (typed === "unknown") return "entry_facts_missing";
    if (typed === "fail") return "entry_rule_failed";
    const legacy: BehaviorRules = { ...rules, entry: { ...rules.entry, signals: { minRequired: 0, checks: [] } } };
    if (reports.some((item) => !engine.preCheckEntryRules(legacy, [privateWithEntryFacts({ chain: "solana", risk_verdict: item.verdict, "risk.verdict": item.verdict },
      facts)]).allowed)) return "entry_rule_failed";
    return null;
  }
  #candidate(agentId: string, rules: PrivateDcaRules, runtime: RunnerAgentState): Candidate | string {
    const o = this.#options; const dca = rules.rules.dca!;
    const positions = o.readPositions(agentId);
    const unmanaged = privateUnmanagedMints(o.readManagedFrom(agentId));
    if (!unmanaged) return "watermark_missing";
    const { adds } = o.store.read(agentId);
    const lots = new Set(adds.map((item) => item.reservationId));
    const attempts = o.readAttempts(agentId);
    const now = this.#now();
    const mints = [...new Set(positions.filter((item) => item.state === "open").map((item) => item.tokenMint))]
      .filter((mint) => dca.mint === undefined || dca.mint === mint);
    let reason = "dca_no_holding";
    for (const mint of mints) {
      if (unmanaged.includes(mint)) { reason = "dca_mint_unmanaged"; continue; }
      const ofMint = positions.filter((item) => item.tokenMint === mint && item.state !== "closed");
      if (ofMint.some((item) => item.state === "held" || item.pendingExit !== null) || o.readExitWanted?.(agentId, mint) === true) { reason = "dca_exit_pending"; continue; }
      if (adds.some((item) => item.mint === mint && privateDcaAddUnsettled(item))) { reason = "dca_add_unsettled"; continue; }
      const parent = [...ofMint].sort((a, b) => b.createdAt - a.createdAt || (a.positionId < b.positionId ? -1 : 1))[0]!;
      if (this.#held(agentId, mint, `${parent.entry.buildDigest}:${rules.revisionId}`)) { reason = this.#holds.get(agentId)?.get(mint)?.reason ?? "dca_held"; continue; }
      // The campaign: started from (or folded with) the mint's opening buys; a DCA lot is never folded (its add is already counted): its
      // add record (kept while the lot is not closed) or its spend reservation's dca: jobId names it.
      let opening: { reservationId: string; costLamports: string; units: string; at: number }[];
      try {
        opening = ofMint.filter((item) => !lots.has(item.entry.reservationId) && !DCA_JOB.test(o.ledger.reservation(agentId, item.entry.reservationId)?.jobId ?? ""))
          .map((item) => ({ reservationId: item.entry.reservationId, costLamports: item.entry.costLamports, units: item.entry.units, at: item.createdAt }));
      } catch { reason = "dca_campaign_unavailable"; continue; }
      let campaign: PrivateDcaCampaign;
      try { campaign = o.store.fold(agentId, mint, opening, now); } catch { reason = "dca_campaign_unavailable"; continue; }
      // The dip trigger reads the freshest valuation of any open lot of the mint (price per unit is the mint's).
      const valuations = ofMint.flatMap((item) => { const value = o.readValuation(agentId, item.positionId); return value ? [value] : []; })
        .filter((item) => now - item.observedAtMs <= PRIVATE_DCA_VALUATION_MAX_AGE_MS && now >= item.observedAtMs).sort((a, b) => b.observedAtMs - a.observedAtMs);
      const valuation = valuations[0];
      const spend = o.ledger.status(agentId, now);
      const perTrade = spend.limits.perTrade.kind === "lamports" ? BigInt(spend.limits.perTrade.lamports) : null;
      const daily = spend.remaining.kind === "lamports" ? BigInt(spend.remaining.lamports) : null;
      if (spend.limits.perTrade.kind === "unset" || spend.remaining.kind === "unset") return "limits_missing";
      // The never-buy symbol and creator lists need the evidence; they are checked on it (#entryRules), never skipped.
      const scan = mintOnlyAvoid(rules.rules);
      const decision = privateDcaDecision({ rules: scan, runtime, nowMs: now, mint, avoid: { mint, symbol: null, creator: null },
        campaign: this.#view(campaign, adds), buysOfToken: privateTokenBuyCount(positions, attempts, mint),
        perTradeCapLamports: perTrade, dailyRemainingLamports: daily,
        ...(valuation ? { quote: { units: BigInt(valuation.units), outLamports: BigInt(valuation.valueLamports) } } : {}) });
      if (!decision.due) { reason = decision.reason; continue; }
      const typed = privateEntryRuleRefusal(scan, { avoid: { mint, symbol: null, creator: null },
        buysOfToken: rules.rules.risk.maxBuysPerToken === undefined ? 0 : privateTokenBuyCount(positions, attempts, mint),
        tradesInLastDay: rules.rules.risk.maxTradesPerDay === undefined ? 0 : privateDailyTradeCount(attempts, o.readEvictedRecentAt(agentId), now) });
      if (typed) { reason = typed; continue; }
      return { mint, parent, amountLamports: decision.amountLamports, trigger: decision.trigger, campaign };
    }
    return reason;
  }
  async #run(agentId: string, candidate: Candidate, rules: PrivateDcaRules, runtime: RunnerAgentState, walletAddress: string,
    evidence: readonly PrivateDcaEvidence[], gates: PrivateExecutionSharedGates, gatePlan: PrivateExecutionGatePlan, signal: AbortSignal): Promise<void> {
    const o = this.#options;
    const key = `${candidate.parent.entry.buildDigest}:${rules.revisionId}`;
    // Re-checked after the evidence read: still no exit of the mint, the parent still open, the shared gates still pass.
    const before = this.#addRefusal(agentId, { reservationId: "", mint: candidate.mint, parentEntryBuildDigest: candidate.parent.entry.buildDigest }, false);
    if (before) { this.#note(agentId, before); return; }
    const recheck = gates.entry(gatePlan, { mint: candidate.mint, maxPositions: rules.maxPositions }, this.#now())
      ?? gates.start(walletAddress, this.#now());
    if (recheck) { this.#note(agentId, recheck); return; }
    const createdAt = this.#now();
    const fields = { localProfileId: o.localProfileId, agentId, reservationId: randomUUID(), mint: candidate.mint, walletAddress,
      parentEntryBuildDigest: candidate.parent.entry.buildDigest, amountLamports: candidate.amountLamports.toString(),
      slippageBps: candidate.parent.entry.slippageBps, ruleRevisionId: rules.revisionId, rulesDigest: rules.rulesDigest,
      exit: structuredClone(rules.exit), trigger: candidate.trigger, runtimeVersion: runtime.version, createdAt };
    const planDigest = privateDcaPlanDigest(fields);
    let add: PrivateDcaAdd;
    // Durable before any reservation or network call that could spend: a crash from here is resolved from the journal, never rebuilt.
    try {
      // An opened add whose lot is not closed is never evicted to make room (it is what keeps that lot from being folded as an opening buy).
      const lotsHeld = new Set(o.readPositions(agentId).filter((item) => item.state !== "closed").map((item) => item.entry.reservationId));
      add = o.store.begin(agentId, { reservationId: fields.reservationId, mint: fields.mint, walletAddress, parentEntryBuildDigest: fields.parentEntryBuildDigest,
        amountLamports: fields.amountLamports, slippageBps: fields.slippageBps, ruleRevisionId: fields.ruleRevisionId, rulesDigest: fields.rulesDigest,
        exit: fields.exit, trigger: fields.trigger, runtimeVersion: fields.runtimeVersion, planDigest, createdAt }, createdAt, lotsHeld);
    } catch (error: unknown) {
      this.#note(agentId, error instanceof Error && "code" in error && typeof error.code === "string" ? `dca:${error.code}` : "dca_unavailable"); return;
    }
    const finish = (change: PrivateDcaAddChange): void => {
      try { o.store.update(agentId, add.reservationId, "running", change, this.#now()); }
      // The add stays running; the next drain resolves it from the journal before anything else starts.
      catch { this.#recovered.delete(agentId); }
      this.#note(agentId, change.state === "submitted" ? null : "reason" in change ? change.reason : null);
    };
    const own = (): string | null => this.#addRefusal(agentId, add, true);
    let built: PrivateExecutionBuildOutcome;
    try { built = await o.build(agentId, { add, evidence, risks: rules.risks, checkAdd: own }, signal); }
    catch { finish({ state: "held", reason: "build_outcome_unknown" }); return; }
    if (built.outcome === "unknown") { finish({ state: built.reservation === "released" ? "refused" : "held", reason: "build_outcome_unknown" }); return; }
    if (built.outcome === "refused") {
      const reason = code(`build:${built.stage}:${built.reason}`);
      finish(built.reservation === "retained" ? { state: "held", reason } : { state: "refused", reason });
      if (TRANSIENT_SERVER.includes(built.reason)) this.#hold(agentId, candidate.mint, built.reason, key, PRIVATE_DCA_RETRY_MS);
      else if (HOLD_SERVER.includes(built.reason)) this.#hold(agentId, candidate.mint, built.reason, key, PRIVATE_DCA_HOLD_MS);
      // Any other refusal (for example a pre-trade verdict that needs approval) backs off growing, so a refusal that repeats never
      // takes an assessment slot and the shared rate window every minute.
      else this.#hold(agentId, candidate.mint, built.reason, key, this.#backoff(agentId, candidate.mint, key));
      return;
    }
    // Withhold an unsent add on exit: the signature is refused (and the reservation released) once any of the add's gates changed.
    const expiry = (): string | null => {
      const refusal = own();
      if (refusal) return refusal;
      return evidence.some((item) => !(this.#now() < Date.parse(item.staleAt))) ? "evidence_stale" : null;
    };
    let submitted: PrivateSubmissionOutcome;
    try { submitted = await o.submit(agentId, built, signal, expiry); }
    catch { finish({ state: "held", reason: "submit_outcome_unknown" }); return; }
    if (submitted.outcome === "refused") {
      if (submitted.reason === "attempt_exists") {
        let attempt: PrivateSubmissionAttempt | undefined;
        try { attempt = o.readAttempts(agentId).find((item) => item.reservationId === add.reservationId); } catch { attempt = undefined; }
        if (attempt) { finish({ state: "submitted", attemptKey: attempt.attemptKey, reason: null }); return; }
      }
      finish(submitted.reservation === "released" ? { state: "refused", reason: code(`submit:${submitted.reason}`) } : { state: "held", reason: code(`submit:${submitted.reason}`) });
      this.#hold(agentId, candidate.mint, submitted.reason, key, this.#backoff(agentId, candidate.mint, key));
      return;
    }
    if (submitted.outcome === "unknown") { finish({ state: "held", reason: code(submitted.reason) }); return; }
    finish({ state: "submitted", attemptKey: submitted.attemptKey, reason: submitted.reason === null ? null : code(submitted.reason) });
    this.#refusals.delete(`${agentId}:${candidate.mint}`);
  }
  /** PRIVATE_DCA_RETRY_MS doubling per consecutive refusal of the same parent and rule head, up to PRIVATE_DCA_HOLD_MS. */
  #backoff(agentId: string, mint: string, key: string): number {
    const id = `${agentId}:${mint}`; const last = this.#refusals.get(id);
    const count = last && last.key === key ? last.count + 1 : 1;
    this.#refusals.set(id, { key, count });
    return Math.min(PRIVATE_DCA_HOLD_MS, PRIVATE_DCA_RETRY_MS * 2 ** Math.min(count - 1, 10));
  }
}
