import { AgentSdkError } from "../errors/agent-sdk-error";
import {
  defaultShouldRetry,
  withRetry,
  type RetryOptions,
} from "../utils/retry";
import type {
  McpCallToolResponse,
  McpListToolsResponse,
} from "../types";

// ── Batch tool call types ─────────────────────────────────────────────────────

export type McpBatchToolCallInput = {
  name: string;
  arguments: Record<string, unknown>;
};

export type McpBatchToolCallResult =
  | {
      success: true;
      name: string;
      index: number;
      result: McpCallToolResponse;
    }
  | {
      success: false;
      name: string;
      index: number;
      error: AgentSdkError;
    };

// ── Health check response type ────────────────────────────────────────────────

export type McpHealthResponse = {
  ok: true;
  publicId: string;
  scope: "read" | "trade" | "manage";
};

export type McpClientConfig = {
  endpoint: string;
  apiKey: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Retry options. Default: 3 attempts with exponential backoff. */
  retry?: RetryOptions;
};

type JsonRpcSuccess<T> = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: T;
};

type JsonRpcError = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type JsonRpcEnvelope<T> = JsonRpcSuccess<T> | JsonRpcError;

// ── Typed tool call helpers ───────────────────────────────────────────────────

/** Extract typed text from a tool call response. Returns empty string on error. */
export function getToolText(response: McpCallToolResponse): string {
  const first = response.content.find((c) => c.type === "text");
  return first?.text ?? "";
}

/** Parse a tool call response text as JSON. Returns null if not valid JSON. */
export function parseToolJson<T = unknown>(response: McpCallToolResponse): T | null {
  const text = getToolText(response);
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Returns true if the tool response indicates an error. */
export function isToolError(response: McpCallToolResponse): boolean {
  return response.isError === true;
}

// ── Typed argument builders ───────────────────────────────────────────────────

export type AskBotArgs = {
  message: string;
  chat_id?: string;
};

export type TradeCommandArgs = {
  message: string;
  chat_id?: string;
  recent_messages?: string[];
  last_mentioned_ca?: string;
};

export type AgentExecuteArgs = {
  instruction: string;
  chat_id?: string;
  metadata?: Record<string, unknown>;
};

export type AgentResearchArgs = {
  query: string;
  chain?: "solana" | "base" | "ethereum";
  includeX?: boolean;
  includeOnchain?: boolean;
  includeDevWallets?: boolean;
  includeHolders?: boolean;
  maxPosts?: number;
};

export type AgentConfigArgs = {
  operation: "get" | "update_trade_defaults" | "update_risk_policy";
  defaults?: Record<string, unknown>;
  policy?: Record<string, unknown>;
};

export type EvmQuoteArgs = {
  chainId?: number;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  slippageBps?: number;
};

export type EvmSwapArgs = EvmQuoteArgs & {
  submit?: boolean;
};

export type AgentSeedRequestArgs = {
  chainId?: number;
  walletAddress?: string;
};

// ── Client ───────────────────────────────────────────────────────────────────

export class BalchemyMcpClient {
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly retryOptions: RetryOptions;

  constructor(config: McpClientConfig) {
    this.endpoint = config.endpoint;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 15_000;
    this.fetchFn = config.fetchFn ?? fetch;
    this.retryOptions = config.retry ?? { maxAttempts: 3 };
  }

  async listTools(): Promise<McpListToolsResponse> {
    return this.rpc<McpListToolsResponse>("tools/list", {});
  }

  async callTool(
    name: string,
    argumentsPayload: Record<string, unknown>
  ): Promise<McpCallToolResponse> {
    return this.rpc<McpCallToolResponse>("tools/call", {
      name,
      arguments: argumentsPayload,
    });
  }

  /**
   * Lightweight health check using the `/health` endpoint.
   * Returns `true` if the API key is valid and MCP is enabled.
   * Falls back to `listTools()` if the health endpoint returns 404
   * (e.g. backend not yet upgraded).
   */
  async ping(): Promise<boolean> {
    try {
      const health = await this.healthCheck();
      return health.ok;
    } catch (err: unknown) {
      // If backend does not yet have /health, fall back to listTools.
      if (
        err instanceof AgentSdkError &&
        (err.status === 404 || err.status === 405)
      ) {
        const tools = await this.listTools();
        return Array.isArray(tools.tools);
      }
      throw err;
    }
  }

  /**
   * Call the lightweight `/health` endpoint for this MCP principal.
   * Throws `AgentSdkError` if unauthorized or not found.
   */
  async healthCheck(): Promise<McpHealthResponse> {
    const healthUrl = `${this.endpoint}/health`;
    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(healthUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
      });

      const raw = await response.text();

      if (!response.ok) {
        let message = `MCP health check failed with status ${response.status}`;
        try {
          const parsed = JSON.parse(raw) as { error?: string | { message?: string } };
          if (typeof parsed.error === "string") {
            message = parsed.error;
          } else if (parsed.error?.message) {
            message = parsed.error.message;
          }
        } catch {
          // ignore parse errors — use default message
        }
        const code =
          response.status === 401
            ? "auth_error"
            : response.status === 429
              ? "rate_limit_error"
              : "execution_error";
        throw new AgentSdkError({ code, status: response.status, message });
      }

      try {
        return JSON.parse(raw) as McpHealthResponse;
      } catch {
        throw new AgentSdkError({
          code: "invalid_response",
          status: response.status,
          message: "Invalid JSON in health response",
          details: raw,
        });
      }
    } catch (error: unknown) {
      if (error instanceof AgentSdkError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "MCP health check failed";
      throw new AgentSdkError({ code: "network_error", message, details: error });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  /**
   * Send multiple tool calls in a single JSON-RPC batch request.
   *
   * The MCP server processes the batch array and returns an array of
   * responses in the same order. Each result is individually marked
   * `success: true | false` — a single failed tool does not abort the batch.
   *
   * NOTE: JSON-RPC batch support requires backend MCP SDK >= 1.x.
   * Use `callToolsParallel()` for automatic fallback on unsupported servers.
   */
  async callToolsBatch(
    calls: McpBatchToolCallInput[]
  ): Promise<McpBatchToolCallResult[]> {
    if (calls.length === 0) {
      return [];
    }

    const ids = calls.map((_, i) => `batch-${i}-${Date.now()}`);
    const batchBody = calls.map((call, i) => ({
      jsonrpc: "2.0" as const,
      id: ids[i],
      method: "tools/call" as const,
      params: { name: call.name, arguments: call.arguments },
    }));

    const controller = new AbortController();
    const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(batchBody),
        signal: controller.signal,
      });

      const raw = await response.text();
      if (!raw) {
        throw new AgentSdkError({
          code: "invalid_response",
          status: response.status,
          message: "Empty batch MCP response",
        });
      }

      const normalized = this.extractSsePayload(raw);
      let parsed: unknown;
      try {
        parsed = JSON.parse(normalized);
      } catch {
        throw new AgentSdkError({
          code: "invalid_response",
          status: response.status,
          message: "Invalid JSON-RPC batch response",
          details: raw,
        });
      }

      // Normalize: server may return a single object if batch has 1 item.
      const responses = Array.isArray(parsed) ? parsed : [parsed];

      return calls.map((call, i): McpBatchToolCallResult => {
        // Match by id; fall back to positional if server reorders.
        const envelope =
          responses.find(
            (r): r is JsonRpcEnvelope<McpCallToolResponse> =>
              typeof r === "object" && r !== null && (r as { id?: unknown }).id === ids[i]
          ) ?? (responses[i] as JsonRpcEnvelope<McpCallToolResponse> | undefined);

        if (!envelope) {
          return {
            success: false,
            name: call.name,
            index: i,
            error: new AgentSdkError({
              code: "invalid_response",
              message: `Missing batch response for tool "${call.name}" at index ${i}`,
            }),
          };
        }

        if (this.isJsonRpcError(envelope)) {
          return {
            success: false,
            name: call.name,
            index: i,
            error: new AgentSdkError({
              code: "execution_error",
              status: response.status,
              message: envelope.error.message,
              details: envelope.error.data,
            }),
          };
        }

        return {
          success: true,
          name: call.name,
          index: i,
          result: envelope.result,
        };
      });
    } catch (error: unknown) {
      if (error instanceof AgentSdkError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "MCP batch request failed";
      throw new AgentSdkError({ code: "network_error", message, details: error });
    } finally {
      globalThis.clearTimeout(timeout);
    }
  }

  /**
   * Execute multiple tool calls with best-effort parallelism.
   *
   * Tries `callToolsBatch()` first (single HTTP round-trip). If the server
   * returns a non-batch-compatible error, falls back to running individual
   * `callTool()` calls in parallel via `Promise.allSettled`.
   *
   * The fallback path maps `PromiseSettledResult` to `McpBatchToolCallResult`
   * so callers always get the same shape regardless of the path taken.
   */
  async callToolsParallel(
    calls: McpBatchToolCallInput[]
  ): Promise<McpBatchToolCallResult[]> {
    if (calls.length === 0) {
      return [];
    }

    try {
      return await this.callToolsBatch(calls);
    } catch (batchError: unknown) {
      // Fallback: individual parallel calls via Promise.allSettled.
      // This path is taken if the server does not support JSON-RPC batch.
      const settled = await Promise.allSettled(
        calls.map((call) => this.callTool(call.name, call.arguments))
      );

      return settled.map((outcome, i): McpBatchToolCallResult => {
        const call = calls[i];
        if (outcome.status === "fulfilled") {
          return { success: true, name: call.name, index: i, result: outcome.value };
        }
        const raw = outcome.reason;
        const error =
          raw instanceof AgentSdkError
            ? raw
            : new AgentSdkError({
                code: "execution_error",
                message: raw instanceof Error ? raw.message : "Tool call failed",
                details: raw,
              });
        return { success: false, name: call.name, index: i, error };
      });
    }
  }

  // ── Typed convenience methods ───────────────────────────────────────────

  /** Natural language query via ask_bot. Use `chat_id` to maintain conversation continuity. */
  async askBot(args: AskBotArgs): Promise<McpCallToolResponse> {
    return this.callTool("ask_bot", args as unknown as Record<string, unknown>);
  }

  /** Direct NLP trade command (regex parser, bypasses LLM). For structured trades, prefer `agentExecute()`. */
  async tradeCommand(args: TradeCommandArgs): Promise<McpCallToolResponse> {
    return this.callTool("trade_command", args as unknown as Record<string, unknown>);
  }

  /** High-level agent execution endpoint. Returns structured envelope with intent/result/metadata. Preferred over `tradeCommand()` for programmatic use. */
  async agentExecute(args: AgentExecuteArgs): Promise<McpCallToolResponse> {
    return this.callTool("agent_execute", args as unknown as Record<string, unknown>);
  }

  /** High-level agent research endpoint. */
  async agentResearch(args: AgentResearchArgs): Promise<McpCallToolResponse> {
    return this.callTool("agent_research", args as unknown as Record<string, unknown>);
  }

  /** High-level portfolio/state snapshot endpoint. */
  async agentPortfolio(): Promise<McpCallToolResponse> {
    return this.callTool("agent_portfolio", {});
  }

  /** High-level runtime/auth status endpoint. */
  async agentStatus(): Promise<McpCallToolResponse> {
    return this.callTool("agent_status", {});
  }

  /** High-level agent config endpoint (get/update). */
  async agentConfig(args: AgentConfigArgs): Promise<McpCallToolResponse> {
    return this.callTool("agent_config", args as unknown as Record<string, unknown>);
  }

  /** EVM swap quote (read-only). */
  async evmQuote(args: EvmQuoteArgs): Promise<McpCallToolResponse> {
    return this.callTool("trading_evm_quote", {
      chainId: 8453,
      ...args,
    } as Record<string, unknown>);
  }

  /**
   * EVM swap execution.
   * By default `submit=false` (pending order) — pass `submit: true` to execute on-chain.
   */
  async evmSwap(args: EvmSwapArgs): Promise<McpCallToolResponse> {
    return this.callTool("trading_evm_swap", {
      chainId: 8453,
      submit: false,
      ...args,
    } as Record<string, unknown>);
  }

  /** Solana Jupiter swap quote (read-only). Requires `MCP_EXPOSE_GRANULAR_TOOLS=true`. */
  async solanaQuote(args: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
  }): Promise<McpCallToolResponse> {
    return this.callTool("trading_solana_jupiter_quote", args as unknown as Record<string, unknown>);
  }

  /**
   * Solana Jupiter swap execution. Requires `MCP_EXPOSE_GRANULAR_TOOLS=true`.
   * By default `submit=false` (pending order) — pass `submit: true` to execute on-chain.
   */
  async solanaSwap(args: {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps?: number;
    submit?: boolean;
  }): Promise<McpCallToolResponse> {
    return this.callTool("trading_solana_jupiter_swap", {
      submit: false,
      ...args,
    } as Record<string, unknown>);
  }

  /**
   * Read an MCP resource by URI (JSON-RPC `resources/read`).
   * Returns the raw contents array. Callers extract `.text` from the first item.
   */
  async readResource(uri: string): Promise<{ uri: string; mimeType?: string; text?: string }[]> {
    const result = await this.rpc<{ contents: { uri: string; mimeType?: string; text?: string }[] }>(
      'resources/read',
      { uri },
    );
    return result.contents ?? [];
  }

  /**
   * @deprecated Seed pool is disabled. Fund custodial wallet via dashboard or on-chain transfer.
   * Kept for backward compatibility; always throws a deterministic SDK error.
   */
  async requestSeed(args?: AgentSeedRequestArgs): Promise<McpCallToolResponse> {
    void args;
    throw new AgentSdkError({
      code: "execution_error",
      message:
        "agent_seed_request is disabled. Fund custodial wallet via dashboard or on-chain transfer.",
      details: {
        tool: "agent_seed_request",
        disabled: true,
      },
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    return withRetry(async () => {
      const controller = new AbortController();
      const timeout = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await this.fetchFn(this.endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: crypto.randomUUID(),
            method,
            params,
          }),
          signal: controller.signal,
        });

        const payload = await this.parseJsonRpc<T>(response);

        if (this.isJsonRpcError(payload)) {
          throw new AgentSdkError({
            code: "execution_error",
            status: response.status,
            message: payload.error.message,
            details: payload.error.data,
          });
        }

        return payload.result;
      } catch (error: unknown) {
        if (error instanceof AgentSdkError) {
          throw error;
        }
        const message = error instanceof Error ? error.message : "MCP request failed";
        throw new AgentSdkError({
          code: "network_error",
          message,
          details: error,
        });
      } finally {
        globalThis.clearTimeout(timeout);
      }
    }, this.resolveRetryOptions(method));
  }

  private resolveRetryOptions(method: string): RetryOptions {
    const configuredShouldRetry = this.retryOptions.shouldRetry;

    return {
      ...this.retryOptions,
      shouldRetry: (error, context): boolean => {
        if (configuredShouldRetry) {
          return configuredShouldRetry(error, context);
        }

        if (
          method === "tools/call" &&
          error instanceof AgentSdkError &&
          error.code === "execution_error"
        ) {
          return false;
        }

        return defaultShouldRetry(error);
      },
    };
  }

  private async parseJsonRpc<T>(response: Response): Promise<JsonRpcEnvelope<T>> {
    const raw = await response.text();
    if (!raw) {
      throw new AgentSdkError({
        code: "invalid_response",
        status: response.status,
        message: "Empty MCP response",
      });
    }

    const normalized = this.extractSsePayload(raw);
    try {
      return JSON.parse(normalized) as JsonRpcEnvelope<T>;
    } catch {
      throw new AgentSdkError({
        code: "invalid_response",
        status: response.status,
        message: "Invalid JSON-RPC payload",
        details: raw,
      });
    }
  }

  private extractSsePayload(raw: string): string {
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"));

    if (lines.length === 0) {
      return raw;
    }

    const last = lines[lines.length - 1];
    return last.replace(/^data:\s*/, "");
  }

  private isJsonRpcError<T>(
    payload: JsonRpcEnvelope<T>
  ): payload is JsonRpcError {
    return (
      typeof payload === "object" &&
      payload !== null &&
      "error" in payload
    );
  }
}

export const connectMcp = (config: McpClientConfig): BalchemyMcpClient => {
  return new BalchemyMcpClient(config);
};
