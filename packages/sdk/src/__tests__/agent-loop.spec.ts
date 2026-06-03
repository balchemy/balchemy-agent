import { AgentLoop } from '../agent-loop/agent-loop';
import type { AgentLoopConfig } from '../agent-loop/types';

describe('AgentLoop', () => {
  it('should initialize with config', () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      maxDailyLlmCost: 5,
    };

    const loop = new AgentLoop(config);
    const status = loop.getStatus();

    expect(status.status).toBe('stopped');
    expect(status.maxDailyLlmCost).toBe(5);
    expect(status.eventsReceived).toBe(0);
  });

  it('should derive SSE endpoint from MCP endpoint', () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
    };

    const loop = new AgentLoop(config);
    expect((loop as unknown as Record<string, unknown>)['sseEndpoint']).toBe('https://api.balchemy.ai/mcp/test123/events/sse');
  });

  it('should report status correctly', () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'anthropic',
      llmApiKey: 'sk-ant-test',
      maxDailyLlmCost: 10,
    };

    const loop = new AgentLoop(config);
    const status = loop.getStatus();

    expect(status.status).toBe('stopped');
    expect(status.maxDailyLlmCost).toBe(10);
    expect(status.sseConnected).toBe(false);
    expect(status.webhookActive).toBe(false);
  });

  it('defaults to shadow mode unless explicitly disabled', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
    };
    const loop = new AgentLoop(config);
    const tradeResults: Array<{ response: string }> = [];
    (loop as unknown as { config: AgentLoopConfig }).config.onTradeResult = (result) => {
      tradeResults.push(result);
    };
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_portfolio') return { content: [{ type: 'text', text: '{}' }] };
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([]);
    (loop as unknown as { decisionHandler: { handleEvent: jest.Mock; getLastCallStats: () => null } }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue({ action: 'buy', amount: '1', token: 'SOL' }),
      getLastCallStats: () => null,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-1',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    const callTool = (loop as unknown as { mcp: { callTool: jest.Mock } }).mcp.callTool;
    expect(callTool).not.toHaveBeenCalledWith('trade_command', expect.anything());
    expect(tradeResults[0]?.response).toContain('Shadow mode');
  });
});
