import { LlmCostTracker } from '../agent-loop/llm-cost-tracker';

describe('LlmCostTracker', () => {
  let tracker: LlmCostTracker;

  beforeEach(() => {
    tracker = new LlmCostTracker({ maxDailyUsd: 5 });
  });

  it('should allow calls within budget', () => {
    expect(tracker.canCallLlm()).toBe(true);
  });

  it('should track cost from token usage', () => {
    tracker.trackCall(1000, 200, 'claude-haiku-4-5');
    expect(tracker.getTodaySpend()).toBeGreaterThan(0);
    expect(tracker.canCallLlm()).toBe(true);
  });

  it('should block when budget exhausted', () => {
    // Force spend to exceed limit
    for (let i = 0; i < 100; i++) {
      tracker.trackCall(50000, 10000, 'claude-sonnet-4');
    }
    expect(tracker.canCallLlm()).toBe(false);
  });

  it('should reset at midnight UTC', () => {
    // Simulate day change
    for (let i = 0; i < 100; i++) {
      tracker.trackCall(50000, 10000, 'claude-sonnet-4');
    }
    expect(tracker.canCallLlm()).toBe(false);
    tracker.resetIfNewDay(new Date(Date.now() + 86400000));
    expect(tracker.canCallLlm()).toBe(true);
    expect(tracker.getTodaySpend()).toBe(0);
  });

  it('should return remaining budget', () => {
    tracker.trackCall(1000, 200, 'claude-haiku-4-5');
    const remaining = tracker.getRemainingBudget();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(5);
  });

  it('should handle unknown models with fallback pricing', () => {
    tracker.trackCall(1000, 200, 'unknown-model-xyz');
    expect(tracker.getTodaySpend()).toBeGreaterThan(0);
  });
});
