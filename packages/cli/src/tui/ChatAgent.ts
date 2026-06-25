/**
 * ChatAgent — External LLM with MCP tool-calling capability.
 *
 * Instead of ask_bot (which uses the internal servant LLM),
 * this calls the user's chosen LLM directly with the MCP tool
 * definitions. Tool availability and execution remain controlled by Balchemy
 * MCP scope, policy, and approval checks.
 *
 * Flow:
 *   User message → External LLM (with tools) → tool call?
 *   → Execute via MCP → feed result back → repeat until text response
 */

import { randomUUID } from "node:crypto";
import type { BalchemyMcpClient } from "@balchemyai/agent-sdk";
import type { TradeConfirmationDetails } from "./types.js";
import { buildTradeConfirmationDetails } from "./trade-confirmation.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ChatAgentConfig {
  llmProvider: "anthropic" | "openai";
  llmApiKey: string;
  llmModel?: string;
  llmBaseUrl?: string;
  llmTimeoutMs?: number;
  publicId?: string;
  sessionId?: string;
  chatId?: string;
}

// ── Known-safe LLM base URLs ─────────────────────────────────────────────────

const KNOWN_BASE_URLS = [
  "https://api.openai.com/v1",
  "https://generativelanguage.googleapis.com/v1beta/openai",
  "https://api.x.ai/v1",
  "https://openrouter.ai/api/v1",
];

const SESSION_AWARE_TOOL_NAMES = new Set([
  "ask_bot",
  "trade_command",
  "agent_readiness_report",
  "agent_context_snapshot",
  "agent_market_brief",
  "agent_candidate_report",
  "agent_risk_report",
]);

const READINESS_TOOL_SEQUENCE = [
  { name: "agent_readiness_report", args: {} },
] as const;

const MAX_SYNTHETIC_TOOL_CALL_ID_LENGTH = 64;

export function makeSyntheticToolCallId(prefix: string): string {
  const randomSegment = randomUUID().replace(/-/g, "");
  const normalizedPrefix = prefix
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "") || "tool";
  const maxPrefixLength = Math.max(
    1,
    MAX_SYNTHETIC_TOOL_CALL_ID_LENGTH - randomSegment.length - 1,
  );

  return `${normalizedPrefix.slice(0, maxPrefixLength)}-${randomSegment}`;
}

function isDefaultOpenAiBaseUrl(baseUrl: string): boolean {
  return baseUrl === "https://api.openai.com/v1";
}

function isOpenAiPlatformApiKey(apiKey: string): boolean {
  return apiKey.startsWith("sk-");
}

type SuggestedToolEnvelope = {
  structured?: {
    query?: unknown;
    suggestedTool?: unknown;
  };
};

function normalizeDiscoveryChain(value: unknown): "solana" | "base" | "ethereum" | undefined {
  return value === "solana" || value === "base" || value === "ethereum"
    ? value
    : undefined;
}

function extractSuggestedToolFollowUp(
  resultText: string,
  sourceArgs: Record<string, unknown>,
): ToolCall | undefined {
  let parsed: SuggestedToolEnvelope;
  try {
    parsed = JSON.parse(resultText) as SuggestedToolEnvelope;
  } catch {
    return undefined;
  }

  if (parsed.structured?.suggestedTool !== "agent_market_brief") {
    return undefined;
  }

  const query = typeof parsed.structured.query === "string"
    ? parsed.structured.query
    : undefined;
  const chain = normalizeDiscoveryChain(sourceArgs.chain);
  const args: Record<string, unknown> = {};
  if (query) {
    args.query = query;
  }
  if (chain) {
    args.chain = chain;
  }

  return {
    id: makeSyntheticToolCallId("suggested"),
    type: "function",
    function: {
      name: "agent_market_brief",
      arguments: JSON.stringify(args),
    },
  };
}

function hasTool(tools: ToolDef[], name: string): boolean {
  return tools.some((tool) => tool.name === name);
}

function sanitizeSessionSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 96);
}

function buildChatId(config: ChatAgentConfig): string {
  if (config.chatId?.trim()) return config.chatId.trim();
  if (config.sessionId?.trim()) return config.sessionId.trim();
  if (config.publicId?.trim()) return `cli-${sanitizeSessionSegment(config.publicId)}`;
  return `cli-${randomUUID()}`;
}

function hasBuyIntent(text: string): boolean {
  return /\b(buy|purchase|long|al|alım|alim|alabilir\w*|alabil\w*|satın al|satin al)\b/i.test(text);
}

function hasSelfSelectionIntent(text: string): boolean {
  return /\b(kendin|kendim|kendi|bulup|bul ve|ara ve|seç|sec|uygun|fırsat|firsat|adaylardan|kurala göre|kurallara göre|matches rules|find and buy|pick one)\b/i.test(text);
}

function inferDiscoveryChainFromText(text: string): "solana" | "base" | undefined {
  if (/\b(solana|sol)\b/i.test(text)) return "solana";
  if (/\b(base|evm|ethereum|eth)\b/i.test(text)) return "base";
  return undefined;
}

function buildAutonomousSelectionDiscoveryCall(userMessage: string, tools: ToolDef[]): ToolCall | undefined {
  if (!hasTool(tools, "agent_market_brief")) return undefined;
  if (!hasBuyIntent(userMessage) || !hasSelfSelectionIntent(userMessage)) return undefined;

  const args: Record<string, unknown> = {
    query: userMessage,
  };
  const chain = inferDiscoveryChainFromText(userMessage);
  if (chain) {
    args.chain = chain;
  }

  return {
    id: makeSyntheticToolCallId("autonomous-discovery"),
    type: "function",
    function: {
      name: "agent_market_brief",
      arguments: JSON.stringify(args),
    },
  };
}

function buildReadinessDiagnosisCalls(userMessage: string, tools: ToolDef[]): ToolCall[] {
  if (!/\b(durum|status|readiness|haz[ıi]r|neden|niye|niçin|nicin|tool|tools|mcp|bakiye|balance|rules|kurallar|aksiyon|action|scheduler|config|konfig)\b/i.test(userMessage)) {
    return [];
  }

  return READINESS_TOOL_SEQUENCE
    .filter((tool) => hasTool(tools, tool.name))
    .map((tool) => ({
      id: makeSyntheticToolCallId(`readiness-${tool.name}`),
      type: "function" as const,
      function: {
        name: tool.name,
        arguments: JSON.stringify(tool.args),
      },
    }));
}

function extractLastMentionedContractAddress(messages: ConversationMessage[]): string | undefined {
  const joined = messages
    .slice(-12)
    .map((message) => message.content)
    .join("\n");
  const evmMatches = joined.match(/0x[a-fA-F0-9]{40}/g);
  if (evmMatches?.length) return evmMatches[evmMatches.length - 1];

  const solanaMatches = joined.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g);
  if (solanaMatches?.length) return solanaMatches[solanaMatches.length - 1];
  return undefined;
}

// ── ChatAgent ─────────────────────────────────────────────────────────────────

export class ChatAgent {
  private readonly config: ChatAgentConfig;
  private readonly mcp: BalchemyMcpClient;
  private tools: ToolDef[] = [];
  private history: ConversationMessage[] = [];
  private readonly replayFetch: typeof fetch;
  private readonly chatId: string;
  private chatQueue: Promise<void> = Promise.resolve();

  constructor(config: ChatAgentConfig, mcp: BalchemyMcpClient, replayFetch: typeof fetch) {
    this.config = config;
    this.mcp = mcp;
    this.replayFetch = replayFetch;
    this.chatId = buildChatId(config);

    // Warn if the LLM base URL is not a known trusted endpoint
    if (
      config.llmBaseUrl &&
      !KNOWN_BASE_URLS.some((u) => config.llmBaseUrl!.startsWith(u))
    ) {
      process.stderr.write(
        `[ChatAgent] Warning: Custom LLM base URL detected: ${config.llmBaseUrl}. Ensure this is a trusted endpoint.\n`,
      );
    }
  }

  /** Fetch MCP tools and prepare system prompt. Call once on start. */
  async init(): Promise<void> {
    try {
      const toolsResp = await this.mcp.listTools();
      this.tools = (toolsResp.tools ?? []).map((t: Record<string, unknown>) => ({
        name: String(t.name ?? ""),
        description: String(t.description ?? ""),
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
    } catch {
      this.tools = [];
    }

    this.history = [{
      role: "system",
      content: `${SYSTEM_PROMPT}\n\nSession identity: use chat_id="${this.chatId}" for session-aware tools when a schema accepts it.`,
    }];
  }

  /**
   * Send a user message, let the LLM respond and call tools as needed.
   * Returns the final text response.
   *
   * @param onToolCall Fired each time the LLM calls a tool (for UI display).
   * @param confirmTrade When set, trade_command calls show a preview and wait
   *   for user confirmation. Return true to proceed, false to cancel.
   */
  async chat(
    userMessage: string,
    onToolCall?: (name: string, result: string) => void,
    confirmTrade?: (details: TradeConfirmationDetails) => Promise<boolean>,
  ): Promise<string> {
    return this.enqueueChat(() => this.runChat(userMessage, onToolCall, confirmTrade));
  }

  /**
   * Ask the selected external LLM for a plain text response with no MCP tools
   * and no conversation-history mutation. Used for setup coaching where the
   * deterministic wizard owns tool execution.
   */
  async completeText(systemPrompt: string, userMessage: string): Promise<string> {
    return this.enqueueChat(() => this.callTextOnly(systemPrompt, userMessage));
  }

  private enqueueChat<T>(run: () => Promise<T>): Promise<T> {
    const previous = this.chatQueue;
    let release: (() => void) | undefined;
    this.chatQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    return previous
      .then(run, run)
      .finally(() => release?.());
  }

  private async runChat(
    userMessage: string,
    onToolCall?: (name: string, result: string) => void,
    confirmTrade?: (details: TradeConfirmationDetails) => Promise<boolean>,
  ): Promise<string> {
    this.history.push({ role: "user", content: userMessage });
    const readinessCalls = buildReadinessDiagnosisCalls(userMessage, this.tools);
    if (readinessCalls.length > 0) {
      this.history.push({
        role: "assistant",
        content: "",
        tool_calls: readinessCalls,
      });
      for (const readinessCall of readinessCalls) {
        await this.executeToolCall(readinessCall, onToolCall, confirmTrade);
      }
      this.history.push({
        role: "system",
        content:
          "You just collected a deterministic readiness/tool-surface diagnosis from agent_readiness_report. Answer with sections: Tool surface, Runtime, Rules/config, Subscriptions, Source health, Action eligibility, Next remediation. Use stable blocker codes from the tool result. If the user asks about fixed-count tool claims, explain the brokered capability model: default tools are high-level agent tools; granular mode exposes explicit read-only non-raw Web3 research tools; raw/provider and mutation surfaces stay brokered or hidden. LP add/remove and lending/borrow execution are not active user-facing tools unless a brokered product surface is added.",
      });
    }
    const autonomousDiscoveryCall = buildAutonomousSelectionDiscoveryCall(userMessage, this.tools);
    if (autonomousDiscoveryCall) {
      this.history.push({
        role: "assistant",
        content: "",
        tool_calls: [autonomousDiscoveryCall],
      });
      await this.executeToolCall(autonomousDiscoveryCall, onToolCall, confirmTrade);
      this.history.push({
        role: "system",
        content: "The latest user authorized candidate selection, not a random trade. Use the read-only market brief and any needed candidate/risk reports to produce a concrete candidate. Do not call trade_command until exact action, chain, token/mint/contract, amount, and non-degraded policy/risk facts are available.",
      });
    }

    const MAX_ROUNDS = 10;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await this.withRetry(() => this.callLlm());

      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.history.push({ role: "assistant", content: response.text });
        return response.text;
      }

      this.history.push({
        role: "assistant",
        content: response.text || "",
        tool_calls: response.toolCalls,
      });

      for (const tc of response.toolCalls) {
        await this.executeToolCall(tc, onToolCall, confirmTrade);
      }
    }

    return "I hit the tool-call limit. Please try a simpler request.";
  }

  private async executeToolCall(
    tc: ToolCall,
    onToolCall: ((name: string, result: string) => void) | undefined,
    confirmTrade: ((details: TradeConfirmationDetails) => Promise<boolean>) | undefined,
  ): Promise<void> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
    } catch {
      args = {};
    }
    args = this.normalizeToolArgs(tc.function.name, args);
    tc.function.arguments = JSON.stringify(args);

    let resultText: string;

    if (tc.function.name === "trade_command") {
      const tradeDetails = buildTradeConfirmationDetails(args);
      if (!tradeDetails.canApprove) {
        resultText = `Trade blocked before MCP call: ${tradeDetails.blockReason ?? "incomplete trade preview"}`;
        this.history.push({ role: "tool", content: resultText, tool_call_id: tc.id });
        return;
      }
      if (!confirmTrade) {
        resultText = "Trade blocked before MCP call: no interactive confirmation callback is available.";
        this.history.push({ role: "tool", content: resultText, tool_call_id: tc.id });
        return;
      }

      const confirmed = await confirmTrade(tradeDetails);
      if (!confirmed) {
        resultText = "Trade cancelled by user.";
        this.history.push({ role: "tool", content: resultText, tool_call_id: tc.id });
        return;
      }
    }

    try {
      const toolResp = await this.mcp.callTool(tc.function.name, args);
      const content = toolResp.content ?? [];
      const textPart = content.find((c: { type: string; text?: string }) => c.type === "text");
      resultText = textPart?.text ?? JSON.stringify(toolResp);
    } catch (err: unknown) {
      resultText = `Error: ${err instanceof Error ? err.message : String(err)}`;
    }

    onToolCall?.(tc.function.name, resultText);

    this.history.push({
      role: "tool",
      content: resultText,
      tool_call_id: tc.id,
    });

    const suggestedToolCall = this.resolveSuggestedToolCall(resultText, tc.function.name, args);
    if (suggestedToolCall) {
      this.history.push({
        role: "assistant",
        content: "",
        tool_calls: [suggestedToolCall],
      });
      await this.executeToolCall(suggestedToolCall, onToolCall, confirmTrade);
    }
  }

  private resolveSuggestedToolCall(
    resultText: string,
    sourceToolName: string,
    sourceArgs: Record<string, unknown>,
  ): ToolCall | undefined {
    if (sourceToolName !== "agent_candidate_report") {
      return undefined;
    }
    if (!this.tools.some((tool) => tool.name === "agent_market_brief")) {
      return undefined;
    }
    return extractSuggestedToolFollowUp(resultText, sourceArgs);
  }

  private normalizeToolArgs(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
    const normalized: Record<string, unknown> = { ...args };
    if (SESSION_AWARE_TOOL_NAMES.has(toolName)) {
      if (typeof normalized.chat_id !== "string" && typeof normalized.conversation_id !== "string") {
        normalized.chat_id = this.chatId;
      }
    }

    if (toolName === "trade_command") {
      if (typeof normalized.idempotency_key !== "string") {
        normalized.idempotency_key = `cli-${randomUUID()}`;
      }
      if (!Array.isArray(normalized.recent_messages)) {
        normalized.recent_messages = this.history
          .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim().length > 0)
          .slice(-8)
          .map((message) => message.content.slice(0, 500));
      }
      if (typeof normalized.last_mentioned_ca !== "string") {
        const lastMentionedCA = extractLastMentionedContractAddress(this.history);
        if (lastMentionedCA) {
          normalized.last_mentioned_ca = lastMentionedCA;
        }
      }
    }

    return normalized;
  }

  // ── Retry logic ────────────────────────────────────────────────────────────

  private static readonly RETRY_DELAYS = [2_000, 4_000, 8_000];

  private static isRetryable(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    // Retry on rate limit (429), service unavailable (503), gateway errors (502)
    if (/\b(429|502|503)\b/.test(msg)) return true;
    // Retry on transient network errors
    if (/ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EPIPE/i.test(msg)) return true;
    return false;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= ChatAgent.RETRY_DELAYS.length; attempt++) {
      try {
        return await fn();
      } catch (err: unknown) {
        lastError = err;
        if (attempt >= ChatAgent.RETRY_DELAYS.length || !ChatAgent.isRetryable(err)) {
          throw err;
        }
        // Extract Retry-After header value if present in error message
        const msg = err instanceof Error ? err.message : String(err);
        const retryAfterMatch = msg.match(/retry[- ]?after[:\s]*(\d+)/i);
        const delayMs = retryAfterMatch
          ? Math.min(Number(retryAfterMatch[1]) * 1_000, 30_000)
          : ChatAgent.RETRY_DELAYS[attempt];
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastError;
  }

  // ── LLM Call ──────────────────────────────────────────────────────────────

  private async callTextOnly(systemPrompt: string, userMessage: string): Promise<string> {
    return this.withRetry(() => {
      if (this.config.llmProvider === "anthropic") {
        return this.callAnthropicTextOnly(systemPrompt, userMessage);
      }
      return this.callOpenAiTextOnly(systemPrompt, userMessage);
    });
  }

  private async callOpenAiTextOnly(systemPrompt: string, userMessage: string): Promise<string> {
    const baseUrl = (this.config.llmBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    if (isDefaultOpenAiBaseUrl(baseUrl) && !isOpenAiPlatformApiKey(this.config.llmApiKey)) {
      throw new Error(
        "OpenAI ChatGPT subscription login is not a Platform API key. Run `balchemy init`, choose OpenAI API Key, and paste a key from platform.openai.com/api-keys.",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs ?? 30_000);

    try {
      const body: Record<string, unknown> = {
        model: this.config.llmModel ?? "gpt-5.4-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        max_completion_tokens: 1200,
        store: false,
      };

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.llmApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM API ${res.status}: ${errText.replace(/\{[\s\S]*\}/g, "").trim().slice(0, 120) || errText.slice(0, 120)}`);
      }

      const data = await res.json() as {
        choices: Array<{
          message: {
            content?: string;
          };
        }>;
      };

      return data.choices[0]?.message.content ?? "";
    } finally {
      clearTimeout(timer);
    }
  }

  private async callAnthropicTextOnly(systemPrompt: string, userMessage: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs ?? 30_000);

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.llmApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.llmModel ?? "claude-haiku-4-5-20251001",
          max_tokens: 1200,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${errText.replace(/\{[\s\S]*\}/g, "").trim().slice(0, 120) || errText.slice(0, 120)}`);
      }

      const data = await res.json() as {
        content: Array<
          | { type: "text"; text: string }
          | { type: string }
        >;
      };

      return data.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");
    } finally {
      clearTimeout(timer);
    }
  }

  private async callLlm(): Promise<{
    text: string;
    toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }> {
    if (this.config.llmProvider === "anthropic") {
      return this.callAnthropic();
    }
    return this.callOpenAi();
  }

  private async callOpenAi(): Promise<{
    text: string;
    toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }> {
    const baseUrl = (this.config.llmBaseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    if (isDefaultOpenAiBaseUrl(baseUrl) && !isOpenAiPlatformApiKey(this.config.llmApiKey)) {
      throw new Error(
        "OpenAI ChatGPT subscription login is not a Platform API key. Run `balchemy init`, choose OpenAI API Key, and paste a key from platform.openai.com/api-keys.",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs ?? 30_000);

    try {
      const body: Record<string, unknown> = {
        model: this.config.llmModel ?? "gpt-5.4-mini",
        messages: this.history,
        max_completion_tokens: 2048,
        store: false,
      };

      if (this.tools.length > 0) {
        body.tools = this.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
          },
        }));
      }

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.llmApiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`LLM API ${res.status}: ${errText.replace(/\{[\s\S]*\}/g, "").trim().slice(0, 120) || errText.slice(0, 120)}`);
      }

      const data = await res.json() as {
        choices: Array<{
          message: {
            content?: string;
            tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
          };
        }>;
      };

      const msg = data.choices[0]?.message;
      return {
        text: msg?.content ?? "",
        toolCalls: msg?.tool_calls,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async callAnthropic(): Promise<{
    text: string;
    toolCalls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.llmTimeoutMs ?? 30_000);

    try {
      // Separate system message
      const systemMsg = this.history.find((m) => m.role === "system");

      // Convert internal (OpenAI-shaped) messages to Anthropic native format.
      // Anthropic requires tool_use blocks in assistant messages and
      // tool_result blocks in user messages — plain-text fallback breaks
      // multi-turn tool interactions.
      type AnthropicContent =
        | string
        | Array<
            | { type: "text"; text: string }
            | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
            | { type: "tool_result"; tool_use_id: string; content: string }
          >;
      const anthropicMsgs: Array<{ role: "user" | "assistant"; content: AnthropicContent }> = [];

      for (const m of this.history) {
        if (m.role === "system") continue;

        if (m.role === "tool") {
          // Tool result → wrap in user message with tool_result block.
          // Anthropic requires tool_result blocks to immediately follow the
          // assistant message that invoked the tool. If the previous message
          // is already a user with tool_result blocks, merge into it.
          const resultBlock = {
            type: "tool_result" as const,
            tool_use_id: m.tool_call_id ?? "",
            content: m.content,
          };
          const prev = anthropicMsgs[anthropicMsgs.length - 1];
          if (prev?.role === "user" && Array.isArray(prev.content)) {
            prev.content.push(resultBlock);
          } else {
            anthropicMsgs.push({ role: "user", content: [resultBlock] });
          }
          continue;
        }

        if (m.role === "assistant" && m.tool_calls?.length) {
          // Assistant message with tool calls → native tool_use blocks
          const blocks: Array<
            | { type: "text"; text: string }
            | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
          > = [];
          if (m.content) {
            blocks.push({ type: "text", text: m.content });
          }
          for (const tc of m.tool_calls) {
            let input: Record<string, unknown>;
            try { input = JSON.parse(tc.function.arguments) as Record<string, unknown>; }
            catch { input = {}; }
            blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
          }
          anthropicMsgs.push({ role: "assistant", content: blocks });
          continue;
        }

        // Regular user or assistant message
        anthropicMsgs.push({ role: m.role as "user" | "assistant", content: m.content });
      }

      const body: Record<string, unknown> = {
        model: this.config.llmModel ?? "claude-haiku-4-5-20251001",
        max_tokens: 2048,
        messages: anthropicMsgs,
      };

      if (systemMsg) body.system = systemMsg.content;

      if (this.tools.length > 0) {
        body.tools = this.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema,
        }));
      }

      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.config.llmApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Anthropic API ${res.status}: ${errText.replace(/\{[\s\S]*\}/g, "").trim().slice(0, 120) || errText.slice(0, 120)}`);
      }

      const data = await res.json() as {
        content: Array<
          | { type: "text"; text: string }
          | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
        >;
      };

      const textParts = data.content.filter((c): c is { type: "text"; text: string } => c.type === "text");
      const toolParts = data.content.filter(
        (c): c is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } => c.type === "tool_use",
      );

      const toolCalls = toolParts.length > 0
        ? toolParts.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.input) },
          }))
        : undefined;

      return {
        text: textParts.map((t) => t.text).join("\n"),
        toolCalls,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── System Prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a Balchemy autonomous Web3 operator agent. You help the user set up and run a long-lived Web3 autonomous loop for Solana and Base: wallet tracking, token tracking, market and liquidity research, launchpad discovery, social research, holder/rug/security checks, policy-gated trading, runtime control, and source-health diagnosis.

You have access to MCP tools via tool calling. Always call tools when you need to take action — never just describe what you would do.

Use only MCP tools that are listed for this session. Do not equate product capability with raw tool count. Balchemy's intended architecture is: default high-level agent tools, optional granular read-only non-raw Web3 research tools, and brokered policy-gated execution. If a user asks where the fixed-count tool catalog went, explain that tools/list is scope/config filtered; raw provider internals and mutation tools are intentionally brokered or hidden; the right target is deep Web3 capability coverage without hallucination, not dumping unsafe raw functions into the LLM.

For runtime, portfolio, wallet, open-position, pending-order, context, or activity snapshot requests, use agent_context_snapshot when it is advertised; otherwise use agent_status and clearly say which data is unavailable. For research, portfolio, new launch, trending-token, liquidity-scan, opportunity, candidate, holder analysis, top holders, bubble maps, rug checks, token/NFT metrics, launch provenance, or Turkish prompts such as "tara" / "yeni launch", use the dedicated advertised safe tool when present: agent_market_brief for broad discovery, agent_candidate_report for one specific asset, agent_risk_report for one specific asset's risk, and any advertised granular read-only tools for deeper drill-down. If the user says "kendin bul", "kendin bulup al", "kurallara göre seç/al", "find and buy", or otherwise authorizes the agent to select an opportunity, treat that as authorization to run read-only discovery and risk/candidate checks first, not as authorization to trade a random unknown token. Use ask_bot only as fallback when no dedicated safe tool is available. Never invent or call tool names that are not available.

If the user asks for LP add/remove, lending, borrow, repay, approvals, withdrawals, wallet provisioning, or other side-effecting DeFi actions and no advertised brokered tool supports that exact action, say this is not active in the current user-facing tool surface. Do not imply the platform has no liquidity research: use pool/liquidity read tools when present. Do not call raw hidden names. Do not route side effects through read-only research tools.

For runtime mutations such as pause, resume, arm, disarm, or set-mode, use agent_control only when it is advertised. If agent_control is not advertised or the MCP key lacks manage scope, say the mutation is unavailable in this session. Do not answer a pause/resume/arm/disarm request by only reading agent_context_snapshot.

Runtime loop vocabulary must be precise. Shadow mode can still monitor, scan, and emit read-only recommendations. armed=false only blocks live execution. paused=true stops the runtime. If the user asks why a loop, scan, or autonomous strategy is not running, distinguish these layers: local CLI cockpit, backend autonomous scheduler, shared market-data ingest, and live trade execution. Do not say "not in loop because armed=false." If market brief/source health reports QUOTA_BLOCKED, SOURCE_INGEST_NOT_CONFIGURED, NO_RECENT_MARKET_EVENTS, SOURCE_CAPACITY_DEGRADED, or another degraded/unavailable reason, say the scan is blocked/degraded by that data/control-plane condition and do not imply the market itself has no tokens.

When answering readiness or "why can't you act?" questions, call agent_readiness_report when it is advertised, then give a compact deterministic diagnosis: Tool surface, Runtime, Rules/config, Subscriptions, Source health, Action eligibility, Next remediation. Stable reason words to use when supported by tool output: USER_CONTEXT_UNAVAILABLE, CONFIG_UNAVAILABLE, MISSING_BEHAVIOR_RULES, MISSING_STRATEGY_TARGET, RUNTIME_STATE_UNAVAILABLE, RUNTIME_NOT_LIVE_ARMED, SCHEDULER_DISABLED, CHAIN_UNSUPPORTED, SOURCE_DEGRADED, TRADING_SERVICE_UNAVAILABLE, NO_ACTIVE_SUBSCRIPTIONS, LIVE_BALANCE_UNAVAILABLE, SETUP_SCOPE_UNAVAILABLE.

## SETUP FLOW

When setup is incomplete, check setup status with the available setup tool. Then guide the user in chat, one question at a time. Do NOT run a separate terminal wizard and do NOT skip steps.

### Step 1: Choose trading networks
- Ask: "Which networks should this agent trade on: Solana, Base (EVM), or both?"

### Step 2: Bind root developer wallet
- If they choose Solana, ask for their Solana root/recovery/withdrawal wallet unless setup status already says solanaWalletBound=true. Explain the same Solana address is used for Solana root, recovery, and withdrawals, and is separate from the generated Solana trading wallet.
- Ask them to paste the same Solana address again only if you need confirmation.
- Use the setup tool to bind the confirmed Solana root wallet.
- If they choose Base/EVM, ask for their Base/EVM 0x developer wallet unless setup status already says evmWalletBound=true. Explain this is the Base root/recovery/Hub/withdrawal wallet; Solana/Base trading wallets are created separately.
- Ask them to paste the same 0x address again only if you need confirmation.
- Use the setup tool to bind the confirmed Base/EVM developer wallet.
- Tell them their master key from the response only when the response includes one. Say clearly that it is shown only once and must be saved. If no master key is returned, say the master key was already created and is not shown again.

### Step 3: Create trading wallets
- If they choose Solana, use the setup tool to create the Solana trading wallet.
- If they choose Base/EVM, use the setup tool to create the Base trading wallet.
- If they choose both, call both tool actions sequentially and show both addresses.
- Funding guidance: Solana needs SOL in the Solana wallet; Base needs ETH in the Base wallet for gas and tokens.

### Step 4: Bind missing Solana root/recovery wallet
- Only ask for this if Solana trading was selected and setup did not already bind a Solana wallet.
- Ask for their Solana root/recovery/withdrawal wallet. Explain this is where SOL/SPL withdrawals go; it is not the generated Solana trading wallet.
- Ask them to paste the same Solana address again for confirmation.
- Use the setup tool to bind the confirmed Solana root/recovery wallet if it is still missing.
- If only Base/EVM was selected, skip this step.

### Step 5: Configure slippage
- Ask for slippage in percent or basis points. Explain: 1% = 100 bps, 3% = 300 bps, 5% = 500 bps.
- If the user answers a plain number like "5" while discussing percent/slippage, treat it as 5% = 500 bps unless they explicitly say "5 bps".
- Use the setup tool to configure slippage with the converted basis-point value.

### Step 6: Configure hard limits and strategy
- Ask for max per-trade limits for the selected networks: max SOL per trade for Solana and/or max USD per trade for Base/EVM.
- Ask for separate natural-language strategy text for Solana and Base when both chains are selected. Keep the chain distinction explicit.
- Each strategy should include entry filters, stop loss, take profit, max concurrent positions and any tokens/categories to avoid.
- Repeat the final strategy back and ask for confirmation before configuring.
- Configure behavior rules only after the user confirms the final strategy. Keep execution approval-gated unless the CLI/backend contract has explicit user authorization for live mode.

### Step 6: Configure event monitoring
- Based on the selected networks and strategy, ask whether to create monitoring subscriptions now.
- For Solana memecoin/new launch strategies, call create_subscription with type="new_token_launch", chain="solana", filter platform="pumpfun" unless the user asks otherwise.
- For Base/EVM strategies, prefer price/volume subscriptions supported by the tool list and ask the user which assets or filters to monitor.

### Step 7: Done
- Tell them setup is complete. Show a summary: selected networks, wallet addresses, slippage, hard limits, strategy and subscriptions.
- Tell them setup is ready and that execution remains governed by MCP scope, policy checks, and explicit approvals.

## IMPORTANT RULES
- Do not claim live execution is enabled by default. Treat setup completion as configured, not executed.
- Complete ALL setup steps before trading.
- Always show wallet addresses. Show the master key only if the setup tool returns one; otherwise say it was already created and is not shown again.
- If the user asks where to fund or which wallet is active, prefer the "Known Balchemy runtime context" included in the latest user message. If that context lists a Solana or Base trading wallet, never say that wallet is not visible.
- Ask questions and wait for answers — don't rush through setup.
- When the user tells you their strategy, repeat it back to confirm before configuring.
- Never assume both chains. Ask Solana/Base/both, then create only the selected chain wallets.
- Never ask for a separate Base trading wallet address; the Base trading wallet is generated by create_wallet chain="base".
- Always ensure a Solana root/recovery/withdrawal wallet exists when Solana is selected. If setup status already has solanaWalletBound=true, reuse it.
- A Solana-created agent can later add Base by binding an EVM wallet. A Base-created agent can later add Solana by binding the Solana root/recovery/withdrawal wallet. Never tell the user to create a new agent just to add the other chain.

## TRADING BEHAVIOR (after setup)
- Explain every decision: what token you found, why it matches their strategy, what you're doing.
- Keep it to 1-3 sentences per decision.
- Show amounts with their actual unit and chain (for example SOL on Solana, ETH/USDC on Base, or token units for sells).
- Respect the user's rules at all times.
- When a tool is unavailable, rate limited, degraded, or not present in tools/list, state that exact condition and stop. Do not say vague follow-ups like "istersen tekrar deneyebilirim" or "I can try again" unless the user asks you to retry. Give the concrete next diagnostic step instead.
- Never treat missing market/risk/provider data as a safe result. Say unavailable/degraded and do not recommend execution.
- Never call trade_command for a random token, unknown token, broad discovery result, missing chain, missing amount, or unresolved ticker. First use read-only discovery/risk tools. If the user explicitly authorizes autonomous selection ("kendin bul", "kurallara göre seç/al"), you may choose a concrete candidate only after evidence is available, then continue with candidate/risk checks and policy-gated trade planning.
- A trade_command request for an exact user-selected token must include exact action, chain, token/mint/contract, and amount, then rely on user confirmation plus backend policy/pretrade gates. A trade_command request for autonomous/self-selected opportunities must also include evidenceId, sourceHealth, missingFacts: [], and exitPolicy from prior read-only discovery/risk evidence. If required facts are unknown, stop with blocked/unavailable; do not send the MCP trade call.
- Do not answer "kendin bulup alabilirsin" with "I cannot find anything myself." You can use safe discovery tools. What you cannot do is execute a random or evidence-free trade.

## LANGUAGE
Respond in the same language the user writes in. Turkish input → Turkish response. English → English.

Be direct. Don't be verbose. Don't add unnecessary pleasantries.`;
