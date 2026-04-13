import { SseEventStream } from '../streaming/sse-event-stream';
import type { SseEvent } from '../streaming/sse-event-stream';
import { BalchemyMcpClient, connectMcp, parseToolJson } from '../mcp/mcp-client';
import { LlmCostTracker } from './llm-cost-tracker';
import { DecisionHandler } from './decision-handler';
import { WebhookReceiver } from './webhook-receiver';
import { OpenAiAdapter } from './llm-adapters/openai';
import { AnthropicAdapter } from './llm-adapters/anthropic';
import { ModelRouter } from './model-router';
import { TelemetryReporter } from './telemetry-reporter';
import type {
  AgentLoopConfig,
  AgentStatus,
  AgentLoopStatus,
  AgentEvent,
  AgentDecision,
  LlmAdapter,
  AgentPortfolioSnapshot,
} from './types';

interface PortfolioCache {
  snapshot: AgentPortfolioSnapshot;
  fetchedAt: number;
}

interface RulesCache {
  compressed: string;
  fetchedAt: number;
}

const PORTFOLIO_TTL_MS = 30_000;    // 30 seconds
const RULES_TTL_MS    = 5 * 60_000; // 5 minutes

export class AgentLoop {
  private readonly config: AgentLoopConfig;
  private readonly sseEndpoint: string;
  private readonly costTracker: LlmCostTracker;
  private readonly llm: LlmAdapter;
  private readonly decisionHandler: DecisionHandler;
  private readonly mcp: BalchemyMcpClient;
  private readonly modelRouter: ModelRouter | null;
  private readonly telemetry: TelemetryReporter;
  private webhookReceiver: WebhookReceiver | null = null;
  private sseStream: SseEventStream | null = null;
  private unsubscribeSse: (() => void) | null = null;

  private status: AgentLoopStatus = 'stopped';
  private startedAt = 0;
  private eventsReceived = 0;
  private decisionsExecuted = 0;
  private tradesExecuted = 0;
  private lastEventAt: number | undefined;
  private lastTradeAt: number | undefined;
  private seenTraceIds = new Set<string>();

  private portfolioCache: PortfolioCache | null = null;
  private rulesCache: RulesCache | null = null;

  /** publicId extracted from the MCP endpoint path (last path segment). */
  private readonly publicId: string;

  constructor(config: AgentLoopConfig) {
    this.config = config;
    this.sseEndpoint = config.sseEndpoint ??
      `${config.mcpEndpoint}/events/sse`;

    // Extract publicId from endpoint (last path segment after filtering empty segments)
    this.publicId = config.mcpEndpoint.split('/').filter(Boolean).pop() ?? '';

    this.costTracker = new LlmCostTracker({
      maxDailyUsd: config.maxDailyLlmCost ?? 5,
    });

    this.llm = this.createLlmAdapter();
    this.decisionHandler = new DecisionHandler(this.llm, this.costTracker, {
      maxConsecutiveFailures: config.maxConsecutiveFailures ?? 3,
    });

    this.mcp = connectMcp({
      endpoint: config.mcpEndpoint,
      apiKey: config.apiKey,
      fetchFn: config.mcpFetchFn,
    });

    // ModelRouter activates only when both cheapModel and fullModel are configured.
    if (config.cheapModel && config.fullModel) {
      this.modelRouter = new ModelRouter({
        cheapModel: config.cheapModel,
        fullModel: config.fullModel,
      });
    } else {
      this.modelRouter = null;
    }

    // Derive the telemetry endpoint from the MCP endpoint:
    //   https://api.balchemy.ai/mcp/abc123  →  https://api.balchemy.ai/api/agent-telemetry/abc123
    const telemetryEndpoint = config.mcpEndpoint.replace(/\/mcp\//, '/api/agent-telemetry/');
    this.telemetry = new TelemetryReporter(telemetryEndpoint, config.apiKey);
  }

  async start(): Promise<void> {
    this.status = 'starting';
    this.startedAt = Date.now();
    this.telemetry.start();

    // Start webhook receiver if configured
    if (this.config.webhookPort && this.config.webhookSecret) {
      this.webhookReceiver = new WebhookReceiver({
        secret: this.config.webhookSecret,
        port: this.config.webhookPort,
      });
      await this.webhookReceiver.start((event) => this.handleEvent(event));
    }

    // Start SSE stream
    this.sseStream = new SseEventStream(this.sseEndpoint, this.config.apiKey, {
      maxReconnects: 0, // unlimited
      reconnectDelayMs: 2000,
      maxReconnectDelayMs: 30_000,
      jitterFactor: 0.25,
    });

    this.unsubscribeSse = this.sseStream.subscribe(
      (sseEvent: SseEvent) => {
        const event: AgentEvent = {
          id: sseEvent.id,
          type: sseEvent.event,
          data: sseEvent.data,
          timestamp: Date.now(),
          source: 'sse',
        };
        this.handleEvent(event);
      },
      (err: unknown) => {
        this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
      },
    );

    this.status = 'running';
    this.config.onStatusChange?.(this.getStatus());
  }

  async stop(): Promise<void> {
    this.status = 'stopped';
    this.unsubscribeSse?.();
    this.sseStream?.close();
    await this.webhookReceiver?.stop();
    this.telemetry.stop();
    this.config.onStatusChange?.(this.getStatus());
  }

  getStatus(): AgentStatus {
    return {
      status: this.status,
      uptime: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
      eventsReceived: this.eventsReceived,
      decisionsExecuted: this.decisionsExecuted,
      tradesExecuted: this.tradesExecuted,
      llmCallsToday: 0,
      llmCostToday: this.costTracker.getTodaySpend(),
      maxDailyLlmCost: this.config.maxDailyLlmCost ?? 5,
      consecutiveLlmFailures: this.decisionHandler.getConsecutiveFailures(),
      lastEventAt: this.lastEventAt,
      lastTradeAt: this.lastTradeAt,
      sseConnected: this.status === 'running',
      webhookActive: this.webhookReceiver !== null,
    };
  }

  /**
   * Send a user message to the bot via the ask_bot MCP tool.
   * Parses the JSON envelope returned by the server and extracts the `reply`
   * field if present; otherwise returns the raw text.
   * On network / tool error, calls `config.onError` and returns an error string.
   */
  async sendMessage(message: string): Promise<string> {
    try {
      const response = await this.mcp.callTool('ask_bot', { message });
      const text = response.content?.find(
        (c: { type: string; text?: string }) => c.type === 'text',
      )?.text ?? '';
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const reply = parsed['reply'] ?? parsed['text'];
        return typeof reply === 'string' ? reply : text;
      } catch {
        return text;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.config.onError?.(new Error(`ask_bot failed: ${msg}`));
      return `Error: ${msg}`;
    }
  }

  private handleEvent(event: AgentEvent): void {
    // Deduplicate across SSE + webhook
    if (event.id && this.seenTraceIds.has(event.id)) return;
    if (event.id) {
      this.seenTraceIds.add(event.id);
      // Limit set size
      if (this.seenTraceIds.size > 10_000) {
        const first = this.seenTraceIds.values().next().value;
        if (first) this.seenTraceIds.delete(first);
      }
    }

    this.eventsReceived++;
    this.lastEventAt = Date.now();
    this.config.onEvent?.(event);

    // Check budget
    if (!this.costTracker.canCallLlm()) {
      if (this.status !== 'budget_exhausted') {
        this.status = 'budget_exhausted';
        this.config.onStatusChange?.(this.getStatus());
      }
      return;
    }

    // Check if decision handler is paused (too many failures)
    if (this.decisionHandler.isPaused()) {
      if (this.status !== 'llm_failing') {
        this.status = 'llm_failing';
        this.config.onStatusChange?.(this.getStatus());
      }
      return;
    }

    // Process asynchronously
    void this.processEvent(event);
  }

  private async processEvent(event: AgentEvent): Promise<void> {
    try {
      // Fetch portfolio and behavior rules (both cached)
      const [portfolio, compressedRules] = await Promise.all([
        this.fetchPortfolio(),
        this.fetchBehaviorRules(),
      ]);

      // Apply model routing if configured
      let selectedModel: string | null = null;
      let modelTier: 'cheap' | 'full' | null = null;
      if (this.modelRouter) {
        const score = this.modelRouter.score(event);
        selectedModel = this.modelRouter.selectModel(event);
        modelTier = score >= 60 ? 'full' : 'cheap';
        this.decisionHandler.setModel(selectedModel);
        this.telemetry.reportModelRoute({
          eventType: event.type,
          score,
          selectedModel,
          tier: modelTier,
        });
      }

      const llmCallStart = Date.now();
      const decision = await this.decisionHandler.handleEvent(event, {
        compressedRules,
        portfolioValue: portfolio.totalValueSol ?? 0,
        portfolioSummary: portfolio.summary,
      });
      const llmLatencyMs = Date.now() - llmCallStart;

      // Report LLM call metrics — DecisionHandler exposes last call stats via getCostTracker
      const lastCall = this.decisionHandler.getLastCallStats();
      if (lastCall) {
        this.telemetry.reportLlmCall({
          model: lastCall.model,
          inputTokens: lastCall.inputTokens,
          outputTokens: lastCall.outputTokens,
          latencyMs: llmLatencyMs,
          costUsd: lastCall.costUsd,
        });
      }

      if (!decision || decision.action === 'hold') return;

      this.decisionsExecuted++;
      this.config.onDecision?.(decision);

      this.telemetry.reportDecision({
        action: decision.action,
        token: decision.token,
        amount: decision.amount,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
      });

      // Execute via MCP
      if (decision.action === 'buy' || decision.action === 'sell') {
        const tradeResponse = await this.mcp.callTool('trade_command', {
          intent: decision.action,
          token: decision.token,
          amount: decision.amount,
        });
        this.tradesExecuted++;
        this.lastTradeAt = Date.now();

        // Fire trade result callback
        const resultText = tradeResponse.content?.find(
          (c: { type: string; text?: string }) => c.type === 'text',
        )?.text ?? '';
        this.config.onTradeResult?.({
          action: decision.action,
          token: decision.token,
          amount: decision.amount,
          response: resultText,
        });
      }
    } catch (err: unknown) {
      this.config.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /**
   * Fetch the agent portfolio via `agent_portfolio` MCP tool.
   * Result is cached for 30 seconds. On failure, returns an empty snapshot
   * so the decision loop continues with degraded context.
   */
  private async fetchPortfolio(): Promise<AgentPortfolioSnapshot> {
    const now = Date.now();
    if (this.portfolioCache && (now - this.portfolioCache.fetchedAt) < PORTFOLIO_TTL_MS) {
      return this.portfolioCache.snapshot;
    }

    try {
      const response = await this.mcp.agentPortfolio();
      const parsed = parseToolJson<AgentPortfolioSnapshot>(response);
      const snapshot: AgentPortfolioSnapshot = parsed ?? {};
      this.portfolioCache = { snapshot, fetchedAt: now };
      return snapshot;
    } catch {
      // Graceful degradation — continue with empty snapshot
      this.config.onError?.(new Error('agent_portfolio fetch failed — continuing with empty snapshot'));
      return {};
    }
  }

  /**
   * Fetch compressed behavior rules from the MCP resource
   * `balchemy://behavior-rules/{publicId}`.
   * Result is cached for 5 minutes. On failure, returns empty string
   * so decisions still proceed without rule context.
   */
  private async fetchBehaviorRules(): Promise<string> {
    const now = Date.now();
    if (this.rulesCache && (now - this.rulesCache.fetchedAt) < RULES_TTL_MS) {
      return this.rulesCache.compressed;
    }

    const uri = `balchemy://behavior-rules/${this.publicId}`;
    try {
      const contents = await this.mcp.readResource(uri);
      const compressed = contents[0]?.text ?? '';
      this.rulesCache = { compressed, fetchedAt: now };
      return compressed;
    } catch {
      // Graceful degradation — continue without rule context
      this.config.onError?.(new Error('behavior-rules resource fetch failed — continuing without rules'));
      return '';
    }
  }

  private createLlmAdapter(): LlmAdapter {
    switch (this.config.llmProvider) {
      case 'anthropic':
        return new AnthropicAdapter(
          this.config.llmApiKey,
          this.config.llmModel,
          this.config.llmTimeoutMs,
        );
      case 'openai':
        return new OpenAiAdapter(
          this.config.llmApiKey,
          this.config.llmModel,
          this.config.llmTimeoutMs,
          this.config.llmBaseUrl,
        );
      case 'custom':
        throw new Error('Custom LLM adapter must be provided via config.llmAdapter');
      default: {
        const exhaustive: never = this.config.llmProvider;
        throw new Error(`Unknown LLM provider: ${exhaustive}`);
      }
    }
  }
}
