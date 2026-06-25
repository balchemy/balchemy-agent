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
    const llm = createMockLlm(JSON.stringify({
      action: 'buy',
      token: 'BONK',
      chain: 'solana',
      amount: '0.3',
      amountUnit: 'SOL',
      amountSource: 'rules',
      confidence: 0.8,
      evidenceId: 'asset:bonk',
      sourceHealth: [{ source: 'agent_risk_report', status: 'ok', fetchedAt: new Date().toISOString() }],
      missingFacts: [],
      requiredApprovals: [],
      exitPolicy: 'take profit at 2x or stop loss at 20%',
      reasoning: 'rules and evidence satisfied',
    }));
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

  it('should convert buy decisions without required execution evidence into blocked decisions', async () => {
    const llm = createMockLlm('{"action":"buy","token":"BONK","amount":"0.3","chain":"solana"}');
    const tracker = new LlmCostTracker({ maxDailyUsd: 5 });
    const handler = new DecisionHandler(llm, tracker);

    const result = await handler.handleEvent(
      createTestEvent('token_price', { symbol: 'BONK', price: 0.00001 }),
      { compressedRules: 'Risk: max 5%', portfolioValue: 10 }
    );

    expect(result?.action).toBe('blocked');
    expect(result?.reasoning).toContain('required evidence');
  });

  it('should accept degraded and blocked non-trade decisions', async () => {
    const llm = createMockLlm('{"action":"degraded","missingFacts":["source_health"],"reasoning":"source unavailable"}');
    const tracker = new LlmCostTracker({ maxDailyUsd: 5 });
    const handler = new DecisionHandler(llm, tracker);

    const result = await handler.handleEvent(
      createTestEvent('source_health', { provider: 'solana_public_rpc_ws' }),
      { compressedRules: 'Risk: hold on degraded sources', portfolioValue: 10 }
    );

    expect(result?.action).toBe('degraded');
    expect(result?.missingFacts).toEqual(['source_health']);
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
