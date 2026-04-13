export type LlmProvider = 'anthropic' | 'openai' | 'custom';

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmAdapter {
  chat(messages: LlmMessage[], maxTokens?: number): Promise<LlmResponse>;
  /** Override the active model for the next call(s). Used by ModelRouter. */
  setModel(model: string): void;
}

export interface AgentLoopConfig {
  /** Balchemy MCP endpoint (e.g., https://api.balchemy.ai/mcp/abc123) */
  mcpEndpoint: string;
  /** Balchemy MCP API key */
  apiKey: string;
  /** LLM provider */
  llmProvider: LlmProvider;
  /** LLM API key */
  llmApiKey: string;
  /** LLM model name (e.g., claude-haiku-4-5, gpt-4o-mini) */
  llmModel?: string;
  /** Custom LLM API base URL (for Gemini, Grok, OpenRouter, or self-hosted). Defaults to provider's official URL. */
  llmBaseUrl?: string;
  /**
   * Cheap model for low-significance events (score < 60).
   * E.g. claude-haiku-4-5, gpt-5-nano. Defaults to llmModel.
   */
  cheapModel?: string;
  /**
   * Full model for high-significance events (score >= 60).
   * E.g. claude-sonnet-4, gpt-5.4-mini. Defaults to llmModel.
   */
  fullModel?: string;
  /** Path to behavior rules YAML file */
  behaviorRulesPath?: string;
  /** Inline behavior rules (alternative to file path) */
  behaviorRules?: Record<string, unknown>;
  /** Max daily LLM spend in USD. Default: 5 */
  maxDailyLlmCost?: number;
  /** SSE event stream endpoint. Derived from mcpEndpoint if omitted. */
  sseEndpoint?: string;
  /** Webhook server port. 0 = disabled. Default: 0 (disabled) */
  webhookPort?: number;
  /** Webhook HMAC secret (from Balchemy dashboard) */
  webhookSecret?: string;
  /** Custom fetch function for MCP requests (e.g., to inject replay protection headers). */
  mcpFetchFn?: typeof fetch;
  /** LLM call timeout in ms. Default: 10000 */
  llmTimeoutMs?: number;
  /** Max consecutive LLM failures before pausing. Default: 3 */
  maxConsecutiveFailures?: number;
  /** Callback: event received */
  onEvent?: (event: AgentEvent) => void;
  /** Callback: decision made */
  onDecision?: (decision: AgentDecision) => void;
  /** Callback: error */
  onError?: (error: Error) => void;
  /** Callback: status changed */
  onStatusChange?: (status: AgentStatus) => void;
  /** Callback: trade result (after trade_command executes) */
  onTradeResult?: (result: { action: string; token?: string; amount?: string; response: string }) => void;
}

/** Lightweight portfolio snapshot returned by agent_portfolio MCP tool. */
export interface AgentPortfolioSnapshot {
  /** Total portfolio value in SOL */
  totalValueSol?: number;
  /** Total portfolio value in USD */
  totalValueUsd?: number;
  /** Summary description for LLM context */
  summary?: string;
  [key: string]: unknown;
}

export interface AgentEvent {
  id?: string;
  type: string;
  data: unknown;
  timestamp: number;
  source: 'sse' | 'webhook';
}

export interface AgentDecision {
  action: string;
  token?: string;
  amount?: string;
  reasoning?: string;
  confidence?: number;
  ruleCorrection?: {
    original: string;
    corrected: string;
    reason: string;
  };
}

export type AgentLoopStatus =
  | 'starting'
  | 'running'
  | 'paused'
  | 'budget_exhausted'
  | 'llm_failing'
  | 'stopped'
  | 'error';

export interface AgentStatus {
  status: AgentLoopStatus;
  uptime: number;
  eventsReceived: number;
  decisionsExecuted: number;
  tradesExecuted: number;
  llmCallsToday: number;
  llmCostToday: number;
  maxDailyLlmCost: number;
  consecutiveLlmFailures: number;
  lastEventAt?: number;
  lastTradeAt?: number;
  sseConnected: boolean;
  webhookActive: boolean;
}

export const DEFAULT_AGENT_LOOP_CONFIG = {
  maxDailyLlmCost: 5,
  llmTimeoutMs: 10_000,
  maxConsecutiveFailures: 3,
  webhookPort: 0,
} as const;
