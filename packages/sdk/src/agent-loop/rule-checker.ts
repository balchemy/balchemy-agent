/**
 * Client-side BehaviorRule pre-check.
 *
 * Enforces hard limits BEFORE a trade_command reaches the backend.
 * The backend has its own post-check (BehaviorRuleEngine); this is an
 * early-exit guard that saves an MCP round-trip and provides immediate
 * developer feedback via the onError callback.
 *
 * Only the two most critical limits are checked here:
 *   - maxTradeSol  — per-trade SOL amount ceiling
 *   - maxTradesPerHour — hourly trade rate cap
 *
 * maxTradeUsd is intentionally omitted: the SDK has no SOL price oracle,
 * and the backend already enforces USD limits server-side.
 */

export interface BehaviorRuleLimits {
  maxTradeSol?: number;
  maxTradesPerHour?: number;
}

export interface RuleCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Validate that a single trade amount does not exceed the per-trade SOL ceiling.
 *
 * @param amount  - Trade amount in SOL (parsed from LLM decision).
 * @param rules   - Active behavior rule limits.
 * @returns `{ allowed: true }` if within limit, or `{ allowed: false, reason }` if blocked.
 */
export function checkTradeAmount(
  amount: number,
  rules: BehaviorRuleLimits,
): RuleCheckResult {
  if (rules.maxTradeSol == null || rules.maxTradeSol <= 0) {
    return { allowed: true };
  }
  if (amount > rules.maxTradeSol) {
    return {
      allowed: false,
      reason: `Trade amount ${amount} SOL exceeds maxTradeSol limit of ${rules.maxTradeSol} SOL`,
    };
  }
  return { allowed: true };
}

/**
 * Validate that the hourly trade count has not been exceeded.
 *
 * @param tradesThisHour - Number of trades already executed in the current hour.
 * @param rules          - Active behavior rule limits.
 * @returns `{ allowed: true }` if within limit, or `{ allowed: false, reason }` if blocked.
 */
export function checkTradeRate(
  tradesThisHour: number,
  rules: BehaviorRuleLimits,
): RuleCheckResult {
  if (rules.maxTradesPerHour == null || rules.maxTradesPerHour <= 0) {
    return { allowed: true };
  }
  if (tradesThisHour >= rules.maxTradesPerHour) {
    return {
      allowed: false,
      reason: `Hourly trade limit reached: ${tradesThisHour}/${rules.maxTradesPerHour} trades this hour`,
    };
  }
  return { allowed: true };
}

/**
 * Run all client-side rule checks against a pending trade decision.
 * Returns the first failing check, or `{ allowed: true }` if all pass.
 */
export function checkAllRules(
  amount: number,
  tradesThisHour: number,
  rules: BehaviorRuleLimits,
): RuleCheckResult {
  const amountCheck = checkTradeAmount(amount, rules);
  if (!amountCheck.allowed) return amountCheck;

  const rateCheck = checkTradeRate(tradesThisHour, rules);
  if (!rateCheck.allowed) return rateCheck;

  return { allowed: true };
}
