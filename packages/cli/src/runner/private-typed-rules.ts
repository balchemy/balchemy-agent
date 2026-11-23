/** K1b runner enforcement of the typed rule grammar (agent-rules compiler 1.3.0, owner decision of 19 Nov 2026). Pure: the callers
 * supply facts and ledgers, and every unknown fact refuses (fail closed). Nothing here grants execution authority.
 *
 * Features this runner enforces and therefore declares (`supportedFeatures`; a revision using any other typed feature is not
 * executable here and holds):
 * - entry_filters.v1: typed entry conditions, evaluated by the shared engine (preCheckEntryRules) over facts keyed by
 *   entryConditionFactKey, before the model is asked (private-outer-decision.ts). Facts: liquidity_usd, market_cap_usd,
 *   volume_1h_usd and volume_24h_usd from the exact research report's candidate (when Balchemy reported them), and
 *   top<N>_holders_pct for N <= 20 from two RPC sources in agreement (private-holder-share.ts). token_age_minutes, holder_count,
 *   buy_tax_pct and sell_tax_pct have no source yet: always unknown, so such a filter holds every buy.
 * - avoid.v1: never-buy mints, symbols (the report's symbol) and creators (no creator fact exists yet: a creator list holds every
 *   buy), at the prefilter and again at the build choke point.
 * - max_buys_per_token.v1: the buys of the token in the CURRENT holding (open or held positions of the mint plus buy attempts that
 *   have no position yet and are not proven not landed), at the build choke point. When every position of the mint is closed the
 *   count starts again, like the DCA cap.
 * - max_trades_per_day.v1: buy and sell attempts the runner signed in the last 24 hours (every journal attempt except one proven not
 *   landed), at the build choke point; exits are never limited. A journal that evicted an attempt of the last day answers unknown.
 * - dca.v1 (K1b, 19 Nov 2026): DCA adds of a held token (private-dca.ts, private-dca-store.ts, private-dca-worker.ts,
 *   private-dca-build.ts), declared once its runner proofs passed. PRIVATE_DCA_ENABLED is derived from this list, so the two never
 *   diverge; without dca.v1 a revision with `dca` has no execution policy here and holds. */
import { BehaviorRuleEngine, coachBehaviorRuleCompilation, DEFAULT_BEHAVIOR_RULES, entryConditionFactKey, isTypedEntryCondition,
  type BehaviorRuleCompilation, type BehaviorRuleExecutionFeature, type BehaviorRuleExecutionOptions, type BehaviorRuleRevision,
  type BehaviorRules, type TypedEntryCondition } from "@balchemyai/agent-rules";
import type { PrivateResearchMarketFacts } from "./private-research-evidence.js";
import type { PrivateHolderShares } from "./private-holder-share.js";
import type { PrivatePosition } from "./private-positions.js";
import { PRIVATE_SUBMISSION_DAY_MS, type PrivateSubmissionAttempt } from "./private-submission-journal.js";

export const PRIVATE_RULE_SUPPORTED_FEATURES: readonly BehaviorRuleExecutionFeature[] = Object.freeze([
  "entry_filters.v1", "avoid.v1", "max_buys_per_token.v1", "max_trades_per_day.v1", "dca.v1"]);
/** The one options value every runner call of isBehaviorRuleRevisionExecutable / deriveBehaviorRuleExecutionPolicy /
 * isBehaviorRuleApprovalAutomatic passes. */
export const PRIVATE_RULE_EXECUTION_OPTIONS: BehaviorRuleExecutionOptions = Object.freeze({ supportedFeatures: PRIVATE_RULE_SUPPORTED_FEATURES });
/** K1b DCA: true exactly when this runner declares dca.v1 (it executes DCA adds); the cockpit reads this instead of its own copy. */
export const PRIVATE_DCA_ENABLED: boolean = PRIVATE_RULE_SUPPORTED_FEATURES.includes("dca.v1");

/** Typed entry facts keyed by entryConditionFactKey; null (or absent) is unknown and never passes a filter. */
export type PrivateEntryFacts = Readonly<Record<string, number | null>>;
const MARKET_FIELDS: Readonly<Record<string, keyof PrivateResearchMarketFacts>> = Object.freeze({
  liquidity_usd: "liquidityUsd", market_cap_usd: "marketCapUsd", volume_1h_usd: "volumeUsd1h", volume_24h_usd: "volumeUsd24h" });
const engine = new BehaviorRuleEngine();

export function privateTypedEntryConditions(rules: BehaviorRules): TypedEntryCondition[] {
  return (rules.entry?.conditions ?? []).filter(isTypedEntryCondition);
}
/** The N of every top_holders_pct filter (the RPC read is made only when a rule needs it). */
export function privateTopHolderCounts(rules: BehaviorRules): number[] {
  return [...new Set(privateTypedEntryConditions(rules).filter((item) => item.field === "top_holders_pct")
    .map((item) => item.topHolderCount ?? 0))].sort((a, b) => a - b);
}
/** One fact object for every typed key the rules use. Market numbers come from each exact report that carried them; two reports
 * that disagree make the fact unknown. Unsupported fields stay unknown. */
export function privateEntryFacts(rules: BehaviorRules, markets: readonly (PrivateResearchMarketFacts | undefined)[],
  holders: PrivateHolderShares): PrivateEntryFacts {
  const facts: Record<string, number | null> = {};
  for (const condition of privateTypedEntryConditions(rules)) {
    const key = entryConditionFactKey(condition);
    if (Object.hasOwn(facts, key)) continue;
    const market = MARKET_FIELDS[condition.field];
    if (market) {
      const values = [...new Set(markets.map((item) => item?.[market]).filter((item): item is number => typeof item === "number" && Number.isFinite(item)))];
      facts[key] = values.length === 1 ? values[0]! : null;
    } else if (condition.field === "top_holders_pct") {
      const value = holders[key]; facts[key] = typeof value === "number" && Number.isFinite(value) ? value : null;
    } else facts[key] = null;
  }
  return Object.freeze(facts);
}
/** The typed facts merged into one legacy fact record (chain, risk verdict); unknown facts are left out (the engine reads absent as
 * unknown). */
export function privateWithEntryFacts(fact: Record<string, unknown>, facts: PrivateEntryFacts): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...fact };
  for (const [key, value] of Object.entries(facts)) if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
  return merged;
}
export type PrivateTypedEntryOutcome = "pass" | "unknown" | "fail";
/** Typed filters only, against one fact record: unknown before fail, as the engine reports them. */
export function privateTypedEntryOutcome(rules: BehaviorRules, facts: PrivateEntryFacts): PrivateTypedEntryOutcome {
  const typed = privateTypedEntryConditions(rules);
  if (typed.length === 0) return "pass";
  for (const condition of typed) {
    const value = facts[entryConditionFactKey(condition)];
    if (engine.evaluateTypedEntryCondition(condition, value) === "unknown") return "unknown";
  }
  const typedOnly: BehaviorRules = { ...rules, entry: { conditions: typed, signals: { minRequired: 0, checks: [] } } };
  return engine.preCheckEntryRules(typedOnly, [privateWithEntryFacts({}, facts)]).allowed ? "pass" : "fail";
}

export interface PrivateAvoidFacts { mint: string; symbol: string | null; creator: string | null }
export type PrivateAvoidOutcome = "pass" | "listed" | "unknown";
/** The never-buy lists: a listed mint, symbol or creator refuses; a configured list kind whose fact is missing is unknown. */
export function privateAvoidOutcome(rules: BehaviorRules, facts: PrivateAvoidFacts): PrivateAvoidOutcome {
  const avoid = rules.avoid;
  if (!avoid) return "pass";
  const result = engine.preCheckAvoid(rules, facts);
  if (result.allowed) return "pass";
  // Both refuse; the distinction only names the reason (the engine's fixed missing-fact texts).
  return /^Token (mint|symbol|creator) fact is (missing|unknown)$/.test(result.reason ?? "") ? "unknown" : "listed";
}

/** Buys of `mint` in the current holding: open or held positions of the mint, plus buy attempts of it that opened no position yet
 * and are not proven not landed (a completed, pending, disputed or owner-closed attempt counts). Null when no position ledger exists. */
export function privateTokenBuyCount(positions: readonly PrivatePosition[] | null, attempts: readonly PrivateSubmissionAttempt[], mint: string): number | null {
  if (!positions) return null;
  const opened = new Set(positions.map((item) => item.entry.reservationId));
  const holding = positions.filter((item) => item.tokenMint === mint && item.state !== "closed").length;
  const pending = attempts.filter((item) => item.swap.direction === "buy" && item.swap.outputMint === mint && !opened.has(item.reservationId)
    && item.state !== "failed_onchain" && item.state !== "expired_not_landed").length;
  return holding + pending;
}
/** The owner's "max N positions at a time" (risk.maxConcurrentPositions, only when the owner's rules state it: privateStatedMaxPositions),
 * enforced at the shared entry gate of every new buy (signal buys and DCA adds): the distinct mints the agent holds or is buying. A
 * mint counts once it has a non-closed position (open or held) or a buy attempt that opened no position yet and is not settled
 * without one: proven not landed (failed_onchain, expired_not_landed) or closed out by the owner (closed_by_owner never opens a
 * position). `outside` lists buy reservations that never become a managed
 * position (evicted closed positions, pre-enable buys, buys the owner took off management): they never count. */
export function privateHeldMints(positions: readonly PrivatePosition[], attempts: readonly PrivateSubmissionAttempt[], outside: ReadonlySet<string>): ReadonlySet<string> {
  const mints = new Set(positions.filter((item) => item.state !== "closed").map((item) => item.tokenMint));
  const opened = new Set(positions.map((item) => item.entry.reservationId));
  for (const item of attempts) {
    if (item.swap.direction !== "buy" || opened.has(item.reservationId) || outside.has(item.reservationId)) continue;
    if (item.state === "failed_onchain" || item.state === "expired_not_landed" || item.state === "closed_by_owner") continue;
    mints.add(item.swap.outputMint);
  }
  return mints;
}
/** The owner's max positions of one revision: N when the owner's rules state "max N positions at a time", `"none"` when they never
 * state one (no limit, owner decision of 21 Nov 2026). */
export type PrivateMaxPositions = number | "none";
/** Whether the owner's rules of `revision` state a max positions at a time, without recompiling or changing it. The compiled rules always
 * carry risk.maxConcurrentPositions (the agent-rules default of 3 when no clause set it), so the value alone cannot tell. The rule coach
 * replays the revision's own compiler version over its exact statements and lists `max_positions` as missing exactly when no accepted
 * clause stated it (the same "State how many positions may be open" hint the owner saw before confirming). Unstated also needs the
 * untouched default of the runner's trusted baseline (a natural-language source onto the default rules); anything else keeps the
 * compiled N. A structured source states every field (the coach counts it stated). Null when it cannot be told (the gate refuses
 * `max_positions_unknown`, fail closed). */
export function privateStatedMaxPositions(revision: BehaviorRuleRevision): PrivateMaxPositions | null {
  try {
    return privateCompilationMaxPositions({ compilerVersion: revision.compilerVersion, status: revision.compilationStatus, chain: revision.chain,
      source: revision.source, rules: revision.rules, rulesDigest: revision.rulesDigest, compiled: revision.compiled,
      compiledDigest: revision.compiledDigest, diagnostics: revision.diagnostics });
  } catch { return null; }
}
/** privateStatedMaxPositions of a compilation not yet confirmed (the setup card's summary of what the rules will do). */
export function privateCompilationMaxPositions(compilation: BehaviorRuleCompilation): PrivateMaxPositions | null {
  try {
    const max = compilation.rules.risk.maxConcurrentPositions;
    if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) return null;
    if (!coachBehaviorRuleCompilation(compilation).missing.includes("max_positions")) return max;
    if (compilation.source.kind !== "natural_language") return max;
    const base = compilation.source.compilationContext.baseRules.risk.maxConcurrentPositions;
    return base === DEFAULT_BEHAVIOR_RULES.risk?.maxConcurrentPositions && max === base ? "none" : max;
  } catch { return null; }
}
/** A buy of a mint not already held is refused once `max` mints are held (`max_positions:<N>`, so the owner text can say "max N positions
 * reached"); a buy of a held mint (a DCA add, a second signal buy of the same token) never adds to the count. `"none"` (the owner's rules
 * never stated a limit) passes without reading the held mints. Unknown held mints (null, undefined or a throw of `readHeld`) or an
 * unknown limit refuse (`max_positions_unknown`, fail closed). */
export function privateMaxPositionsRefusal(readHeld: () => ReadonlySet<string> | null | undefined, mint: string,
  max: PrivateMaxPositions | null | undefined): string | null {
  if (max === "none") return null;
  if (typeof max !== "number" || !Number.isSafeInteger(max) || max < 1) return "max_positions_unknown";
  let held: ReadonlySet<string> | null | undefined;
  try { held = readHeld(); } catch { held = undefined; }
  if (!held) return "max_positions_unknown";
  return held.has(mint) || held.size < max ? null : `max_positions:${max}`;
}
/** The never-buy lists of one buy (signal buy at the build choke point, DCA add on its evidence): a listed mint or symbol refuses
 * `rule_avoid_listed`; a missing fact refuses and names it (`rule_fact_unknown:symbol` when a symbol list exists and no single symbol is
 * known, else `rule_fact_unknown:creator`: no creator fact exists yet). */
export function privateAvoidRefusal(rules: BehaviorRules, facts: PrivateAvoidFacts): "rule_avoid_listed" | "rule_fact_unknown:symbol" | "rule_fact_unknown:creator" | null {
  const avoid = privateAvoidOutcome(rules, facts);
  if (avoid === "listed") return "rule_avoid_listed";
  if (avoid === "unknown") return (rules.avoid?.symbols.length ?? 0) > 0 && !facts.symbol ? "rule_fact_unknown:symbol" : "rule_fact_unknown:creator";
  return null;
}
/** Attempts signed in the rolling 24 hours before `nowMs` (buys and sells; only one proven not landed is left out), or null when the
 * journal evicted an attempt of that window (the count would be short). */
export function privateDailyTradeCount(attempts: readonly PrivateSubmissionAttempt[], evictedRecentAt: number | null, nowMs: number): number | null {
  if (!Number.isFinite(nowMs)) return null;
  const since = nowMs - PRIVATE_SUBMISSION_DAY_MS;
  if (evictedRecentAt !== null && evictedRecentAt > since) return null;
  return attempts.filter((item) => item.createdAt > since && item.createdAt <= nowMs && item.state !== "expired_not_landed").length;
}

export const PRIVATE_ENTRY_RULE_REFUSALS = ["rule_avoid_listed", "rule_fact_unknown", "rule_token_buy_limit", "rule_daily_trade_limit"] as const;
export type PrivateEntryRuleRefusal = typeof PRIVATE_ENTRY_RULE_REFUSALS[number];
export interface PrivateEntryLimitFacts { avoid: PrivateAvoidFacts; buysOfToken: number | null; tradesInLastDay: number | null }
/** The build choke point's typed-rule check of one buy (exits never pass through here). */
export function privateEntryRuleRefusal(rules: BehaviorRules, facts: PrivateEntryLimitFacts): PrivateEntryRuleRefusal | null {
  const avoid = privateAvoidOutcome(rules, facts.avoid);
  if (avoid === "listed") return "rule_avoid_listed";
  if (avoid === "unknown") return "rule_fact_unknown";
  if (rules.risk.maxBuysPerToken !== undefined) {
    if (facts.buysOfToken === null) return "rule_fact_unknown";
    if (!engine.preCheckTokenBuyCount(rules, facts.buysOfToken).allowed) return "rule_token_buy_limit";
  }
  if (rules.risk.maxTradesPerDay !== undefined) {
    if (facts.tradesInLastDay === null) return "rule_fact_unknown";
    if (!engine.preCheckDailyTradeRate(rules, facts.tradesInLastDay).allowed) return "rule_daily_trade_limit";
  }
  return null;
}
/** The build choke point's typed rules of one signal buy (the daemon's checkEntry): the never-buy lists with the symbol the decision's own
 * reports carry (`symbol`, null when unknown), the per-token buy limit over the current holding and the rolling 24-hour trade count. */
export function privateBuildEntryRefusal(rules: BehaviorRules, facts: { mint: string; symbol: string | null; positions: readonly PrivatePosition[] | null;
  attempts: readonly PrivateSubmissionAttempt[]; evictedRecentAt: number | null; nowMs: number }): string | null {
  const avoid = { mint: facts.mint, symbol: facts.symbol, creator: null };
  const listed = privateAvoidRefusal(rules, avoid);
  if (listed) return listed;
  return privateEntryRuleRefusal(rules, { avoid,
    buysOfToken: rules.risk.maxBuysPerToken === undefined ? 0 : privateTokenBuyCount(facts.positions, facts.attempts, facts.mint),
    tradesInLastDay: rules.risk.maxTradesPerDay === undefined ? 0 : privateDailyTradeCount(facts.attempts, facts.evictedRecentAt, facts.nowMs) });
}
/** Owner text of each refusal (cockpit and `runner trades`). */
export function privateEntryRuleRefusalText(reason: PrivateEntryRuleRefusal): string {
  switch (reason) {
    case "rule_avoid_listed": return "Not bought: the token is on your never-buy list.";
    case "rule_fact_unknown": return "Not bought: a fact one of your rules needs is unknown (for example the token's creator), so the rule holds the buy.";
    case "rule_token_buy_limit": return "Not bought: your per-token buy limit is reached for this holding.";
    case "rule_daily_trade_limit": return "Not bought: your trades-per-day limit is reached for the last 24 hours.";
  }
}
