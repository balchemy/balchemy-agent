/**
 * AgentLoop — portfolio + rules fetch logic tests.
 *
 * Tests the private fetchPortfolio() and fetchBehaviorRules() methods
 * indirectly via processEvent(), using a jest-mocked BalchemyMcpClient.
 */

import { AgentLoop } from '../agent-loop/agent-loop';
import type { AgentLoopConfig, AgentEvent, LlmAdapter, LlmResponse } from '../agent-loop/types';

// ── Helpers ────────────────────────────────────────────────────────────────

type LoopInternals = {
  fetchPortfolio: () => Promise<unknown>;
  fetchBehaviorRules: () => Promise<string>;
  portfolioCache: { snapshot: unknown; fetchedAt: number } | null;
  rulesCache: { compressed: string; fetchedAt: number } | null;
  mcp: {
    agentPortfolio: jest.Mock;
    readResource: jest.Mock;
    callTool: jest.Mock;
  };
};

function asInternals(loop: AgentLoop): LoopInternals {
  return loop as unknown as LoopInternals;
}

function makeMcpToolResponse(text: string) {
  return {
    content: [{ type: 'text', text }],
    isError: false,
  };
}

function makeConfig(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
  return {
    mcpEndpoint: 'https://api.balchemy.ai/mcp/abc123',
    apiKey: 'balc_test',
    llmProvider: 'openai',
    llmApiKey: 'sk-test',
    maxDailyLlmCost: 5,
    ...overrides,
  };
}

function makeEvent(type = 'token_price', data: unknown = {}): AgentEvent {
  return { id: 'evt-1', type, data, timestamp: Date.now(), source: 'sse' };
}

function makeMockLlm(decision = '{"action":"hold"}'): LlmAdapter {
  return {
    chat: jest.fn().mockResolvedValue({
      text: decision,
      model: 'test-model',
      inputTokens: 10,
      outputTokens: 10,
    } satisfies LlmResponse),
    setModel: jest.fn(),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('AgentLoop — fetch logic', () => {
  let loop: AgentLoop;
  let internals: LoopInternals;

  beforeEach(() => {
    loop = new AgentLoop(makeConfig());
    internals = asInternals(loop);

    // Replace real MCP client with mocks
    internals.mcp.agentPortfolio = jest.fn().mockResolvedValue(
      makeMcpToolResponse('{"totalValueSol":12.5,"summary":"Healthy portfolio"}'),
    );
    internals.mcp.readResource = jest.fn().mockResolvedValue([
      { uri: 'balchemy://behavior-rules/abc123', text: 'Max position: 5%' },
    ]);
    internals.mcp.callTool = jest.fn().mockResolvedValue(makeMcpToolResponse('ok'));
  });

  describe('fetchPortfolio()', () => {
    it('parses portfolio response and returns snapshot', async () => {
      const snapshot = await internals.fetchPortfolio();
      expect(snapshot).toEqual({ totalValueSol: 12.5, summary: 'Healthy portfolio' });
      expect(internals.mcp.agentPortfolio).toHaveBeenCalledTimes(1);
    });

    it('caches result — second call within TTL skips MCP', async () => {
      await internals.fetchPortfolio();
      await internals.fetchPortfolio();
      expect(internals.mcp.agentPortfolio).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after cache expiry', async () => {
      await internals.fetchPortfolio();
      // Backdate cache to force expiry
      internals.portfolioCache!.fetchedAt = Date.now() - 31_000;
      await internals.fetchPortfolio();
      expect(internals.mcp.agentPortfolio).toHaveBeenCalledTimes(2);
    });

    it('returns empty snapshot on MCP failure (graceful degradation)', async () => {
      internals.mcp.agentPortfolio = jest.fn().mockRejectedValue(new Error('network error'));
      const errors: Error[] = [];
      (loop as unknown as { config: AgentLoopConfig }).config.onError = (e) => errors.push(e);

      const snapshot = await internals.fetchPortfolio();
      expect(snapshot).toEqual({});
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('agent_portfolio fetch failed');
    });

    it('returns empty snapshot when MCP returns invalid JSON', async () => {
      internals.mcp.agentPortfolio = jest.fn().mockResolvedValue(
        makeMcpToolResponse('not-json'),
      );
      const snapshot = await internals.fetchPortfolio();
      expect(snapshot).toEqual({});
    });
  });

  describe('fetchBehaviorRules()', () => {
    it('returns compressed rules text', async () => {
      const rules = await internals.fetchBehaviorRules();
      expect(rules).toBe('Max position: 5%');
      expect(internals.mcp.readResource).toHaveBeenCalledWith(
        'balchemy://behavior-rules/abc123',
      );
    });

    it('caches result — second call within 5min TTL skips MCP', async () => {
      await internals.fetchBehaviorRules();
      await internals.fetchBehaviorRules();
      expect(internals.mcp.readResource).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after rules cache expiry', async () => {
      await internals.fetchBehaviorRules();
      // Backdate cache by 5min + 1s
      internals.rulesCache!.fetchedAt = Date.now() - (5 * 60_000 + 1_000);
      await internals.fetchBehaviorRules();
      expect(internals.mcp.readResource).toHaveBeenCalledTimes(2);
    });

    it('returns empty string on MCP failure (graceful degradation)', async () => {
      internals.mcp.readResource = jest.fn().mockRejectedValue(new Error('timeout'));
      const errors: Error[] = [];
      (loop as unknown as { config: AgentLoopConfig }).config.onError = (e) => errors.push(e);

      const rules = await internals.fetchBehaviorRules();
      expect(rules).toBe('');
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('behavior-rules resource fetch failed');
    });

    it('returns empty string when contents array is empty', async () => {
      internals.mcp.readResource = jest.fn().mockResolvedValue([]);
      const rules = await internals.fetchBehaviorRules();
      expect(rules).toBe('');
    });
  });

  describe('ModelRouter integration', () => {
    it('selectModel is called and setModel delegated when cheapModel+fullModel configured', async () => {
      const configWithRouter = makeConfig({
        cheapModel: 'gpt-5-nano',
        fullModel: 'gpt-5.4-mini',
      });
      const routedLoop = new AgentLoop(configWithRouter);
      const ri = asInternals(routedLoop);

      // Inject mock MCP
      ri.mcp.agentPortfolio = jest.fn().mockResolvedValue(makeMcpToolResponse('{}'));
      ri.mcp.readResource = jest.fn().mockResolvedValue([]);
      ri.mcp.callTool = jest.fn().mockResolvedValue(makeMcpToolResponse('ok'));

      // Inject mock LLM that confirms setModel was called
      const mockLlm = makeMockLlm('{"action":"hold"}');
      (routedLoop as unknown as { llm: LlmAdapter }).llm = mockLlm;
      (routedLoop as unknown as { decisionHandler: { llm: LlmAdapter; setModel: (m: string) => void } })
        .decisionHandler.llm = mockLlm;

      // Trigger processEvent directly
      await (routedLoop as unknown as { processEvent: (e: AgentEvent) => Promise<void> })
        .processEvent(makeEvent('token_price', {}));

      // setModel must have been called (cheap model for token_price score=20)
      expect(mockLlm.setModel).toHaveBeenCalledWith('gpt-5-nano');
    });

    it('setModel is NOT called when cheapModel/fullModel not configured', async () => {
      const ri = asInternals(loop);
      ri.mcp.agentPortfolio = jest.fn().mockResolvedValue(makeMcpToolResponse('{}'));
      ri.mcp.readResource = jest.fn().mockResolvedValue([]);
      ri.mcp.callTool = jest.fn().mockResolvedValue(makeMcpToolResponse('ok'));

      const mockLlm = makeMockLlm('{"action":"hold"}');
      (loop as unknown as { llm: LlmAdapter }).llm = mockLlm;
      (loop as unknown as { decisionHandler: { llm: LlmAdapter } }).decisionHandler.llm = mockLlm;

      await (loop as unknown as { processEvent: (e: AgentEvent) => Promise<void> })
        .processEvent(makeEvent('token_price', {}));

      expect(mockLlm.setModel).not.toHaveBeenCalled();
    });
  });
});
