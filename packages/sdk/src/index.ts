import { HttpClient } from "./client/http-client";
import { AgentOnboardingClient } from "./auth/onboarding";
import { BalchemyMcpClient, connectMcp } from "./mcp/mcp-client";
import type {
  AgentSdkConfig,
  IdentityTokenRevokeResponse,
  IdentityTokenRevokeStatusInput,
  OnboardWithIdentityInput,
  OnboardWithSiweInput,
  OnboardingResponse,
  RevokeIdentityTokenInput,
  RequestSiweNonceInput,
  SiweNonceResponse,
} from "./types";

export type {
  AgentSdkConfig,
  AgentOnboardingMode,
  AgentScope,
  IdentityAccess,
  OnboardWithIdentityInput,
  OnboardWithSiweInput,
  OnboardingResponse,
  RevokeIdentityTokenInput,
  IdentityTokenRevokeStatusInput,
  IdentityTokenRevokeResponse,
  RequestSiweNonceInput,
  SiweNonceResponse,
  McpTool,
  McpListToolsResponse,
  McpCallToolResponse,
  AgentResponse,
  McpToolExtensions,
  McpToolWithMetadata,
} from "./types";
export type { AgentSdkErrorCode } from "./errors/error-codes";
export { AgentSdkError } from "./errors/agent-sdk-error";
export { BalchemyMcpClient, connectMcp, getToolText, parseToolJson, isToolError } from "./mcp/mcp-client";
export type {
  AskBotArgs,
  TradeCommandArgs,
  AgentExecuteArgs,
  AgentResearchArgs,
  AgentConfigArgs,
  EvmQuoteArgs,
  EvmSwapArgs,
  McpBatchToolCallInput,
  McpBatchToolCallResult,
  McpHealthResponse,
} from "./mcp/mcp-client";
export { SseEventStream } from "./streaming/sse-event-stream";
export type { SseEvent, SseStreamOptions } from "./streaming/sse-event-stream";
export type {
  StoredToken,
  TokenRefreshFn,
  TokenStoreOptions,
} from "./auth/token-store";
export { TokenStore } from "./auth/token-store";

// Agent Loop
export { AgentLoop } from './agent-loop/agent-loop';
export { LlmCostTracker } from './agent-loop/llm-cost-tracker';
export { DecisionHandler } from './agent-loop/decision-handler';
export { WebhookReceiver } from './agent-loop/webhook-receiver';
export { OpenAiAdapter } from './agent-loop/llm-adapters/openai';
export { AnthropicAdapter } from './agent-loop/llm-adapters/anthropic';
export type {
  AgentLoopConfig,
  AgentStatus,
  AgentLoopStatus,
  AgentEvent,
  AgentDecision,
  LlmAdapter,
  LlmMessage,
  LlmResponse,
  LlmProvider,
} from './agent-loop/types';

export class BalchemyAgentSdk {
  private readonly onboarding: AgentOnboardingClient;

  constructor(config: AgentSdkConfig) {
    const timeoutMs = config.timeoutMs ?? 15_000;
    const http = new HttpClient({
      baseUrl: config.apiBaseUrl,
      timeoutMs,
      fetchFn: config.fetchFn,
    });
    this.onboarding = new AgentOnboardingClient(http);
  }

  async requestSiweNonce(input: RequestSiweNonceInput): Promise<SiweNonceResponse> {
    return this.onboarding.requestSiweNonce(input);
  }

  async onboardWithSiwe(input: OnboardWithSiweInput): Promise<OnboardingResponse> {
    return this.onboarding.onboardWithSiwe(input);
  }

  async onboardWithIdentity(
    input: OnboardWithIdentityInput
  ): Promise<OnboardingResponse> {
    return this.onboarding.onboardWithIdentity(input);
  }

  async revokeIdentityToken(
    input: RevokeIdentityTokenInput
  ): Promise<IdentityTokenRevokeResponse> {
    return this.onboarding.revokeIdentityToken(input);
  }

  async getIdentityTokenRevokeStatus(
    input: IdentityTokenRevokeStatusInput
  ): Promise<IdentityTokenRevokeResponse> {
    return this.onboarding.getIdentityTokenRevokeStatus(input);
  }

  connectMcp(params: {
    endpoint: string;
    apiKey: string;
    timeoutMs?: number;
    fetchFn?: typeof fetch;
  }): BalchemyMcpClient {
    return connectMcp(params);
  }
}
