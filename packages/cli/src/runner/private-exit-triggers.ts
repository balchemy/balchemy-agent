/** S5c pure exit-trigger evaluation: no IO, no clock, no keys, integer arithmetic only. The runner evaluates the position's
 * private exit snapshot (copied from the plan that opened it) against a fresh, complete sell assessment of ALL remaining units;
 * Balchemy never re-evaluates a trigger (rules stay local), it only binds the exit to the assessment the runner names.
 *
 * Every comparison uses the value normalised to the position's ORIGINAL size, so a partial take-profit never moves the
 * stop-loss, the ladder or the trailing reference:
 *   norm = floor(valueLamports * originalUnits / remainingUnits)   (lamports for the whole original position at today's price)
 * against cost = the lamports the entries spent (their gross input, the buy platform fee included).
 *
 * Priority within one evaluation (one decision per pass):
 * 1. stop-loss:     norm * 10000 <= cost * (10000 - stopLossBps)                      -> sell every remaining unit
 * 2. trailing stop: armed once norm * 10000 >= cost * (10000 + trailingActivateBps); the high-water mark is the highest norm
 *                   seen while armed (the caller persists it); fires when norm * 10000 <= highWater * (10000 - trailingStopBps)
 *                                                                                      -> sell every remaining unit
 * 3. take-profit:   the lowest unfired level i with norm * 10000 >= cost * (10000 + triggerBps_i)
 *                   -> sell floor(originalUnits * sellBps_i / 10000) units (at least 1), capped by what remains; the level that
 *                      completes 10000 bps of the ladder sells everything that remains (no dust).
 * A valuation that is not complete, not for exactly the remaining units, older than PRIVATE_EXIT_VALUATION_MAX_AGE_MS or observed
 * more than PRIVATE_EXIT_VALUATION_MAX_SKEW_MS in the local future (the SDK's own server-timestamp bound; inside it the age counts
 * as 0) is a HOLD: a stale or missing price never fabricates a trigger. Malformed input throws (fail closed).
 * The value is the quote's net of the platform fee; the network fee (a fixed per-transaction cost) is deliberately not modelled
 * here: scaled to the original size it would let a fee alone fire a stop-loss on a small remainder. Recorded proceeds are net of
 * it (private-position-facts.ts), so readback never overstates a sale.
 *
 * Item 6 (recheckPrivatePartialExit): a partial take-profit sells against a SECOND assessment of exactly its units; that
 * assessment must, normalised the same way, still yield exactly the same decision (same trigger, level and units) or the exit is
 * aborted with an explicit reason. L6 (privateExitHeadroomBps): how far, in bps, the last valuation was from the nearest
 * DOWNSIDE trigger (stop-loss, armed trailing stop); the worker values positions near one more often. */

export const PRIVATE_EXIT_VALUATION_MAX_AGE_MS = 15_000;
export const PRIVATE_EXIT_VALUATION_MAX_SKEW_MS = 5_000;
export const PRIVATE_EXIT_TRIGGERS = ["stop_loss", "take_profit", "trailing_stop"] as const;
export type PrivateExitTrigger = typeof PRIVATE_EXIT_TRIGGERS[number];
export const PRIVATE_EXIT_HOLD_REASONS = ["position_closed", "valuation_unavailable", "valuation_stale"] as const;
export type PrivateExitHoldReason = typeof PRIVATE_EXIT_HOLD_REASONS[number];
export const PRIVATE_EXIT_MAX_TAKE_PROFIT_LEVELS = 16;

/** The plan's exit snapshot (agent-rules BehaviorRuleExitSnapshot): bps relative to the entry cost. */
export interface PrivateExitSnapshot {
  readonly stopLossBps: number;
  readonly takeProfitLevels: ReadonlyArray<{ readonly triggerBps: number; readonly sellBps: number }>;
  readonly trailingActivateBps?: number;
  readonly trailingStopBps?: number;
}
/** Position facts the evaluation needs. trailingArmed is true exactly when highWaterLamports is set. */
export interface PrivateExitPositionFacts {
  readonly costLamports: string; readonly originalUnits: string; readonly remainingUnits: string;
  /** Indices of fired take-profit levels; always a prefix of the ladder (levels fire lowest first). */
  readonly takeProfitFired: readonly number[];
  readonly trailingArmed: boolean; readonly highWaterLamports: string | null;
}
/** One sell assessment of `units` token units: net expected proceeds (quote.outAmount - quote.platformFeeLamports). */
export interface PrivateExitValuation { readonly complete: boolean; readonly units: string; readonly valueLamports: string; readonly observedAtMs: number }
export interface PrivateExitTrailing { readonly trailingArmed: boolean; readonly highWaterLamports: string | null }
export type PrivateExitDecision =
  | { readonly action: "hold"; readonly reason: PrivateExitHoldReason }
  | { readonly action: "none"; readonly trailing: PrivateExitTrailing }
  | { readonly action: "sell"; readonly trigger: PrivateExitTrigger; readonly units: string; readonly level: number | null;
      readonly trailing: PrivateExitTrailing };

export type PrivateExitRecheck = { readonly ok: true }
  | { readonly ok: false; readonly reason: "valuation_unavailable" | "valuation_stale" | "trigger_not_met" | "trigger_changed" };

export class PrivateExitTriggerError extends Error {
  constructor() { super("Invalid private exit trigger input"); this.name = "PrivateExitTriggerError"; }
}
function fail(): never { throw new PrivateExitTriggerError(); }
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const TEN = 10_000n;
function u64(value: unknown, minimum = 0n): bigint {
  if (typeof value !== "string" || !U64.test(value)) fail();
  const result = BigInt(value); if (result < minimum || result > U64_MAX) fail(); return result;
}
function bps(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) fail(); return value;
}

/** The plan parser's exit rules (private-signal-plan.ts): stop-loss 1..10000; <= 16 levels with strictly increasing triggers
 * 1..100000 and sells 1..10000 totalling <= 10000; the trailing pair together, stop 1..10000 below activate 1..100000. */
export function privateExitSnapshotValid(snapshot: unknown): snapshot is PrivateExitSnapshot {
  try {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return false;
    const s = snapshot as Record<string, unknown>;
    const keys = Object.keys(s).sort().join(",");
    const trailing = s.trailingActivateBps !== undefined || s.trailingStopBps !== undefined;
    if (keys !== (trailing ? "stopLossBps,takeProfitLevels,trailingActivateBps,trailingStopBps" : "stopLossBps,takeProfitLevels")) return false;
    bps(s.stopLossBps, 10_000);
    const levels = s.takeProfitLevels;
    if (!Array.isArray(levels) || levels.length > PRIVATE_EXIT_MAX_TAKE_PROFIT_LEVELS) return false;
    let previous = 0; let total = 0;
    for (const level of levels as unknown[]) {
      if (!level || typeof level !== "object" || Object.keys(level).sort().join(",") !== "sellBps,triggerBps") return false;
      const l = level as Record<string, unknown>;
      const trigger = bps(l.triggerBps, 100_000); const sell = bps(l.sellBps, 10_000);
      if (trigger <= previous) return false;
      previous = trigger; total += sell;
    }
    if (total > 10_000) return false;
    if (trailing && bps(s.trailingStopBps, 10_000) >= bps(s.trailingActivateBps, 100_000)) return false;
    return true;
  } catch { return false; }
}

export function evaluatePrivateExit(snapshot: PrivateExitSnapshot, position: PrivateExitPositionFacts, valuation: PrivateExitValuation,
  nowMs: number): PrivateExitDecision {
  if (!privateExitSnapshotValid(snapshot)) fail();
  const cost = u64(position.costLamports, 1n); const original = u64(position.originalUnits, 1n); const remaining = u64(position.remainingUnits);
  if (remaining > original) fail();
  const levels = snapshot.takeProfitLevels;
  const fired = position.takeProfitFired;
  if (!Array.isArray(fired) || fired.length > levels.length || fired.some((index, at) => index !== at)) fail();
  const highWater = position.highWaterLamports === null ? null : u64(position.highWaterLamports, 1n);
  if (typeof position.trailingArmed !== "boolean" || position.trailingArmed !== (highWater !== null)
    || (position.trailingArmed && snapshot.trailingActivateBps === undefined)) fail();
  if (remaining === 0n) return Object.freeze({ action: "hold", reason: "position_closed" });
  if (typeof valuation !== "object" || valuation === null || typeof valuation.complete !== "boolean") fail();
  if (!valuation.complete || u64(valuation.units, 1n) !== remaining) return Object.freeze({ action: "hold", reason: "valuation_unavailable" });
  if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(valuation.observedAtMs) || valuation.observedAtMs > nowMs + PRIVATE_EXIT_VALUATION_MAX_SKEW_MS
    || Math.max(0, nowMs - valuation.observedAtMs) > PRIVATE_EXIT_VALUATION_MAX_AGE_MS) return Object.freeze({ action: "hold", reason: "valuation_stale" });
  const norm = u64(valuation.valueLamports) * original / remaining;

  let armed = position.trailingArmed; let water = highWater;
  if (snapshot.trailingActivateBps !== undefined && !armed && norm * TEN >= cost * (TEN + BigInt(snapshot.trailingActivateBps))) { armed = true; water = norm; }
  if (armed && water !== null && norm > water) water = norm;
  const trailing: PrivateExitTrailing = Object.freeze({ trailingArmed: armed, highWaterLamports: water === null ? null : water.toString() });
  const sell = (trigger: PrivateExitTrigger, units: bigint, level: number | null): PrivateExitDecision =>
    Object.freeze({ action: "sell", trigger, units: units.toString(), level, trailing });

  if (norm * TEN <= cost * (TEN - BigInt(snapshot.stopLossBps))) return sell("stop_loss", remaining, null);
  if (snapshot.trailingStopBps !== undefined && armed && water !== null && norm * TEN <= water * (TEN - BigInt(snapshot.trailingStopBps))) {
    return sell("trailing_stop", remaining, null);
  }
  const next = fired.length;
  const level = levels[next];
  if (level && norm * TEN >= cost * (TEN + BigInt(level.triggerBps))) {
    const firedBps = levels.slice(0, next + 1).reduce((total, item) => total + item.sellBps, 0);
    let units = original * BigInt(level.sellBps) / TEN;
    if (units < 1n) units = 1n;
    if (firedBps >= 10_000 || units > remaining) units = remaining;
    return sell("take_profit", units, next);
  }
  return Object.freeze({ action: "none", trailing });
}

/** Item 6: re-checks a partial sell decision against the second assessment of exactly `decision.units`. Its value is scaled to
 * all remaining units (floor(value * remaining / units), never rounding up) and evaluated exactly like the first valuation with
 * the trailing state that valuation produced; anything but the very same sell (trigger, level, units) refuses: a price that
 * fell back below the level (`trigger_not_met`), a stop-loss or trailing stop that would now fire instead (`trigger_changed`),
 * or incomplete, mismatched or stale evidence. Malformed input throws (fail closed). */
export function recheckPrivatePartialExit(snapshot: PrivateExitSnapshot, position: PrivateExitPositionFacts,
  decision: Extract<PrivateExitDecision, { action: "sell" }>, valuation: PrivateExitValuation, nowMs: number): PrivateExitRecheck {
  const refuse = (reason: Extract<PrivateExitRecheck, { ok: false }>["reason"]): PrivateExitRecheck => Object.freeze({ ok: false as const, reason });
  const remaining = u64(position.remainingUnits, 1n); const units = u64(decision.units, 1n);
  if (units > remaining || typeof decision.trailing !== "object" || decision.trailing === null) fail();
  if (typeof valuation !== "object" || valuation === null || typeof valuation.complete !== "boolean") fail();
  if (!valuation.complete || u64(valuation.units, 1n) !== units) return refuse("valuation_unavailable");
  const scaled = u64(valuation.valueLamports) * remaining / units;
  if (scaled > U64_MAX) return refuse("valuation_unavailable");
  const again = evaluatePrivateExit(snapshot, { costLamports: position.costLamports, originalUnits: position.originalUnits,
    remainingUnits: position.remainingUnits, takeProfitFired: position.takeProfitFired, trailingArmed: decision.trailing.trailingArmed,
    highWaterLamports: decision.trailing.highWaterLamports }, { complete: true, units: position.remainingUnits, valueLamports: scaled.toString(),
    observedAtMs: valuation.observedAtMs }, nowMs);
  if (again.action === "hold") return refuse(again.reason === "valuation_stale" ? "valuation_stale" : "valuation_unavailable");
  if (again.action === "none") return refuse("trigger_not_met");
  if (again.trigger !== decision.trigger || again.level !== decision.level || again.units !== decision.units) return refuse("trigger_changed");
  return Object.freeze({ ok: true as const });
}

/** L6: the smallest distance, in bps, between one valuation and a DOWNSIDE trigger of the position, measured like the evaluation
 * (norm against cost; the trailing stop against the high-water mark): the stop-loss, and the trailing stop while armed. Upside
 * triggers (an unfired ladder level, the trailing activation) are deliberately ignored: a take-profit valued late costs nothing,
 * a stop valued late can cost the position. 0 at or past a trigger; capped at 1_000_000. Pass the trailing state the evaluation
 * of this valuation produced. Malformed input throws. */
export function privateExitHeadroomBps(snapshot: PrivateExitSnapshot, position: PrivateExitPositionFacts, valueLamports: string): number {
  if (!privateExitSnapshotValid(snapshot)) fail();
  const cost = u64(position.costLamports, 1n); const original = u64(position.originalUnits, 1n); const remaining = u64(position.remainingUnits, 1n);
  if (remaining > original || !Array.isArray(position.takeProfitFired)) fail();
  const norm = u64(valueLamports) * original / remaining;
  const ratio = norm * TEN / cost;
  const gaps: bigint[] = [ratio - (TEN - BigInt(snapshot.stopLossBps))];
  if (snapshot.trailingStopBps !== undefined && position.trailingArmed) {
    const water = u64(position.highWaterLamports, 1n);
    gaps.push(norm * TEN / water - (TEN - BigInt(snapshot.trailingStopBps)));
  }
  const least = gaps.reduce((low, gap) => (gap < low ? gap : low));
  return least <= 0n ? 0 : least >= 1_000_000n ? 1_000_000 : Number(least);
}
