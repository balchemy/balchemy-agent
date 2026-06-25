import { AgentLoop } from '../agent-loop/agent-loop';
import type { AgentLoopConfig } from '../agent-loop/types';

describe('AgentLoop', () => {
  type MockDecisionHandler = {
    handleEvent: jest.Mock;
    getLastCallStats: () => null;
    getConsecutiveFailures: () => number;
  };

  const executableBuyDecision = {
    action: 'buy' as const,
    amount: '1',
    amountUnit: 'SOL',
    token: 'BONK',
    chain: 'solana',
    amountSource: 'rules',
    evidenceId: 'asset:bonk',
    sourceHealth: [{ source: 'agent_risk_report', status: 'ok', fetchedAt: new Date().toISOString() }],
    missingFacts: [],
    requiredApprovals: [],
    exitPolicy: 'take profit at 2x or stop loss at 20%',
  };

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

  it('sends stable chat_id when routing user chat through ask_bot', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
    };
    const loop = new AgentLoop(config);
    (loop as unknown as { mcp: { callTool: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: '{"reply":"ok"}' }] });

    await loop.sendMessage('durum ne');

    expect((loop as unknown as { mcp: { callTool: jest.Mock } }).mcp.callTool)
      .toHaveBeenCalledWith('ask_bot', {
        message: 'durum ne',
        chat_id: 'sdk-test123',
      });
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
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_armed","armed":true,"paused":false}}}',
            }],
          };
        }
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue(executableBuyDecision),
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
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

  it('does not call trade_command when backend runtime is not live_armed', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    const tradeResults: Array<{ response: string }> = [];
    (loop as unknown as { config: AgentLoopConfig }).config.onTradeResult = (result) => {
      tradeResults.push(result);
    };
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_unarmed","armed":false,"paused":false}}}',
            }],
          };
        }
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue(executableBuyDecision),
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-2',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    const callTool = (loop as unknown as { mcp: { callTool: jest.Mock } }).mcp.callTool;
    expect(callTool).not.toHaveBeenCalledWith('trade_command', expect.anything());
    expect(tradeResults[0]?.response).toContain('Runtime not armed');
  });

  it('skips LLM decisions when backend runtime is paused', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    const handleEvent = jest.fn();
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"paused","armed":false,"paused":true}}}',
            }],
          };
        }
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent,
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-paused',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    expect(handleEvent).not.toHaveBeenCalled();
  });

  it('skips LLM decisions when behavior rules are unavailable', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    const tradeResults: Array<{ response: string }> = [];
    const handleEvent = jest.fn();
    (loop as unknown as { config: AgentLoopConfig }).config.onTradeResult = (result) => {
      tradeResults.push(result);
    };
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_armed","armed":true,"paused":false}}}',
            }],
          };
        }
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent,
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-no-rules',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    expect(handleEvent).not.toHaveBeenCalled();
    expect(tradeResults[0]?.response).toContain('behavior rules are unavailable');
  });

  it('allows trade_command only when local live mode and backend runtime are armed', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_armed","armed":true,"paused":false}}}',
            }],
          };
        }
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue(executableBuyDecision),
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-3',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    const callTool = (loop as unknown as { mcp: { callTool: jest.Mock } }).mcp.callTool;
    expect(callTool).toHaveBeenCalledWith('trade_command', expect.objectContaining({
      message: 'buy 1 SOL BONK on solana',
      chat_id: 'sdk-test123',
      autonomous: true,
      requiresEvidence: true,
      evidenceId: 'asset:bonk',
      sourceHealth: expect.arrayContaining([expect.objectContaining({ source: 'agent_risk_report', status: 'ok' })]),
      missingFacts: [],
      requiredApprovals: [],
      exitPolicy: 'take profit at 2x or stop loss at 20%',
      amountUnit: 'SOL',
      amountSource: 'rules',
    }));
    const tradeCall = callTool.mock.calls.find((call) => call[0] === 'trade_command');
    expect(tradeCall?.[1]?.idempotency_key).toMatch(/^sdk-/);
  });

  it('does not count non-submitted trade_command responses as executed trades', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    const tradeResults: Array<{ action: string; response: string }> = [];
    (loop as unknown as { config: AgentLoopConfig }).config.onTradeResult = (result) => {
      tradeResults.push(result);
    };
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_armed","armed":true,"paused":false}}}',
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: '{"structured":{"result":{"success":false,"message":"approval required"}}}',
          }],
        };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue(executableBuyDecision),
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-approval-required',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    expect(loop.getStatus().tradesExecuted).toBe(0);
    expect(tradeResults[0]?.action).toBe('approval_required');
  });

  it('does not count success true without execution status or order reference as an executed trade', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    const tradeResults: Array<{ action: string; response: string }> = [];
    (loop as unknown as { config: AgentLoopConfig }).config.onTradeResult = (result) => {
      tradeResults.push(result);
    };
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_armed","armed":true,"paused":false}}}',
            }],
          };
        }
        return {
          content: [{
            type: 'text',
            text: '{"structured":{"result":{"success":true,"submitted":false,"message":"policy checks passed"}}}',
          }],
        };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue(executableBuyDecision),
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-success-without-order',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    expect(loop.getStatus().tradesExecuted).toBe(0);
    expect(tradeResults[0]?.action).toBe('blocked');
  });

  it('blocks buy decisions that are missing execution evidence', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    const tradeResults: Array<{ action: string; response: string }> = [];
    (loop as unknown as { config: AgentLoopConfig }).config.onTradeResult = (result) => {
      tradeResults.push(result);
    };
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_armed","armed":true,"paused":false}}}',
            }],
          };
        }
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue({ action: 'buy', amount: '1', token: 'BONK', chain: 'solana' }),
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-missing-evidence',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    const callTool = (loop as unknown as { mcp: { callTool: jest.Mock } }).mcp.callTool;
    expect(callTool).not.toHaveBeenCalledWith('trade_command', expect.anything());
    expect(tradeResults[0]?.action).toBe('blocked');
    expect(tradeResults[0]?.response).toContain('amount unit');
  });

  it('blocks buy decisions with sourceHealth that lacks a positive health signal', async () => {
    const config: AgentLoopConfig = {
      mcpEndpoint: 'https://api.balchemy.ai/mcp/test123',
      apiKey: 'balc_test',
      llmProvider: 'openai',
      llmApiKey: 'sk-test',
      shadowMode: false,
    };
    const loop = new AgentLoop(config);
    const tradeResults: Array<{ action: string; response: string }> = [];
    (loop as unknown as { config: AgentLoopConfig }).config.onTradeResult = (result) => {
      tradeResults.push(result);
    };
    (loop as unknown as { mcp: { callTool: jest.Mock; readResource: jest.Mock } }).mcp.callTool = jest
      .fn()
      .mockImplementation(async (name: string) => {
        if (name === 'agent_status') {
          return {
            content: [{
              type: 'text',
              text: '{"structured":{"autonomous_runtime":{"mode":"live_armed","armed":true,"paused":false}}}',
            }],
          };
        }
        return { content: [{ type: 'text', text: 'executed' }] };
      });
    (loop as unknown as { mcp: { readResource: jest.Mock } }).mcp.readResource = jest
      .fn()
      .mockResolvedValue([{ text: 'rules: max 1 SOL per trade' }]);
    (loop as unknown as { decisionHandler: MockDecisionHandler }).decisionHandler = {
      handleEvent: jest.fn().mockResolvedValue({ ...executableBuyDecision, sourceHealth: { provider: 'mock' } }),
      getLastCallStats: () => null,
      getConsecutiveFailures: () => 0,
    };

    await (loop as unknown as { processEvent: (event: unknown) => Promise<void> }).processEvent({
      id: 'evt-weak-source-health',
      type: 'token_price',
      data: {},
      timestamp: Date.now(),
      source: 'sse',
    });

    const callTool = (loop as unknown as { mcp: { callTool: jest.Mock } }).mcp.callTool;
    expect(callTool).not.toHaveBeenCalledWith('trade_command', expect.anything());
    expect(tradeResults[0]?.action).toBe('degraded');
    expect(tradeResults[0]?.response).toContain('source health');
  });
});
