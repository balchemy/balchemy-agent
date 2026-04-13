import { DecisionHandler } from '../agent-loop/decision-handler';
import type { LlmAdapter, LlmResponse, AgentEvent } from '../agent-loop/types';
import { LlmCostTracker } from '../agent-loop/llm-cost-tracker';

function createMockLlm(response: string): LlmAdapter {
  return {
    chat: jest.fn().mockResolvedValue({
      text: response,
      model: 'test-model',
      inputTokens: 100,
      outputTokens: 50,
    } satisfies LlmResponse),
    setModel: jest.fn(),
  };
}

function createTestEvent(type: string, data: unknown = {}): AgentEvent {
  return { id: 'test-1', type, data, timestamp: Date.now(), source: 'sse' };
}

describe('DecisionHandler', () => {
  it('should call LLM and return parsed decision', async () => {
    const llm = createMockLlm('{"action":"buy","token":"BONK","amount":"0.3 SOL"}');
    const tracker = new LlmCostTracker({ maxDailyUsd: 5 });
    const handler = new DecisionHandler(llm, tracker);

    const result = await handler.handleEvent(
      createTestEvent('token_price', { symbol: 'BONK', price: 0.00001 }),
      { compressedRules: 'Risk: max 5%', portfolioValue: 10 }
    );

    expect(result).not.toBeNull();
    expect(result!.action).toBe('buy');
    expect(llm.chat).toHaveBeenCalledTimes(1);
  });

  it('should return null when budget exhausted', async () => {
    const llm = createMockLlm('{"action":"buy"}');
    const tracker = new LlmCostTracker({ maxDailyUsd: 0 }); // Zero budget
    const handler = new DecisionHandler(llm, tracker);

    const result = await handler.handleEvent(
      createTestEvent('token_price', {}),
      { compressedRules: '', portfolioValue: 10 }
    );

    expect(result).toBeNull();
    expect(llm.chat).not.toHaveBeenCalled();
  });

  it('should return null on LLM timeout', async () => {
    const llm: LlmAdapter = {
      chat: jest.fn().mockRejectedValue(new Error('timeout')),
      setModel: jest.fn(),
    };
    const tracker = new LlmCostTracker({ maxDailyUsd: 5 });
    const handler = new DecisionHandler(llm, tracker);

    const result = await handler.handleEvent(
      createTestEvent('token_price', {}),
      { compressedRules: '', portfolioValue: 10 }
    );

    expect(result).toBeNull();
  });

  it('should return null on invalid JSON response', async () => {
    const llm = createMockLlm('this is not json');
    const tracker = new LlmCostTracker({ maxDailyUsd: 5 });
    const handler = new DecisionHandler(llm, tracker);

    const result = await handler.handleEvent(
      createTestEvent('token_price', {}),
      { compressedRules: '', portfolioValue: 10 }
    );

    expect(result).toBeNull();
  });

  it('should track consecutive failures', async () => {
    const llm: LlmAdapter = {
      chat: jest.fn().mockRejectedValue(new Error('fail')),
      setModel: jest.fn(),
    };
    const tracker = new LlmCostTracker({ maxDailyUsd: 5 });
    const handler = new DecisionHandler(llm, tracker, { maxConsecutiveFailures: 2 });

    await handler.handleEvent(createTestEvent('test', {}), { compressedRules: '', portfolioValue: 10 });
    expect(handler.getConsecutiveFailures()).toBe(1);
    expect(handler.isPaused()).toBe(false);

    await handler.handleEvent(createTestEvent('test', {}), { compressedRules: '', portfolioValue: 10 });
    expect(handler.getConsecutiveFailures()).toBe(2);
    expect(handler.isPaused()).toBe(true);
  });

  it('should reset failure count on success', async () => {
    const llm = createMockLlm('{"action":"hold"}');
    const tracker = new LlmCostTracker({ maxDailyUsd: 5 });
    const handler = new DecisionHandler(llm, tracker);

    // Force a failure first
    (llm.chat as jest.Mock).mockRejectedValueOnce(new Error('fail'));
    await handler.handleEvent(createTestEvent('test', {}), { compressedRules: '', portfolioValue: 10 });
    expect(handler.getConsecutiveFailures()).toBe(1);

    // Then success
    await handler.handleEvent(
      createTestEvent('test', {}),
      { compressedRules: '', portfolioValue: 10 }
    );
    expect(handler.getConsecutiveFailures()).toBe(0);
  });
});
