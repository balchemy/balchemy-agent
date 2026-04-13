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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
});
