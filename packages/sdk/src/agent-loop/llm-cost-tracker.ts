// Approximate pricing per million tokens (USD) — updated 2026-04
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 0.25, output: 1.25 },
  'claude-sonnet-4': { input: 3.0, output: 15.0 },
  'claude-opus-4': { input: 15.0, output: 75.0 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
  'gpt-5-nano': { input: 0.05, output: 0.40 },
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o': { input: 2.50, output: 10.0 },
};

const FALLBACK_PRICING = { input: 1.0, output: 5.0 };

export interface LlmCostTrackerConfig {
  maxDailyUsd: number;
}

export class LlmCostTracker {
  private readonly maxDailyUsd: number;
  private todaySpendUsd = 0;
  private todayCallCount = 0;
  private currentDay: string;

  constructor(config: LlmCostTrackerConfig) {
    this.maxDailyUsd = config.maxDailyUsd;
    this.currentDay = this.getDayKey(new Date());
  }

  canCallLlm(): boolean {
    this.resetIfNewDay(new Date());
    return this.todaySpendUsd < this.maxDailyUsd;
  }

  trackCall(inputTokens: number, outputTokens: number, model: string): void {
    this.resetIfNewDay(new Date());
    const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
    const cost =
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output;
    this.todaySpendUsd += cost;
    this.todayCallCount += 1;
  }

  getCallCount(): number {
    this.resetIfNewDay(new Date());
    return this.todayCallCount;
  }

  getTodaySpend(): number {
    this.resetIfNewDay(new Date());
    return this.todaySpendUsd;
  }

  getRemainingBudget(): number {
    this.resetIfNewDay(new Date());
    return Math.max(0, this.maxDailyUsd - this.todaySpendUsd);
  }

  /**
   * Returns the USD cost for a single LLM call without mutating state.
   * Used by DecisionHandler to surface cost to TelemetryReporter.
   */
  computeCallCost(inputTokens: number, outputTokens: number, model: string): number {
    const pricing = MODEL_PRICING[model] ?? FALLBACK_PRICING;
    return (
      (inputTokens / 1_000_000) * pricing.input +
      (outputTokens / 1_000_000) * pricing.output
    );
  }

  resetIfNewDay(now: Date): void {
    const dayKey = this.getDayKey(now);
    if (dayKey !== this.currentDay) {
      this.todaySpendUsd = 0;
      this.todayCallCount = 0;
      this.currentDay = dayKey;
    }
  }

  private getDayKey(date: Date): string {
    return date.toISOString().slice(0, 10);
  }
}
