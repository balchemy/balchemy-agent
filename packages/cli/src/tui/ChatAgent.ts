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
}

// ── Known-safe LLM base URLs ─────────────────────────────────────────────────

const KNOWN_BASE_URLS = [
  "https://api.openai.com/v1",
  "https://generativelanguage.googleapis.com/v1beta/openai",
  "https://api.x.ai/v1",
  "https://openrouter.ai/api/v1",
];

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
    id: `suggested-${randomUUID()}`,
    type: "function",
    function: {
      name: "agent_market_brief",
      arguments: JSON.stringify(args),
    },
  };
}

// ── ChatAgent ─────────────────────────────────────────────────────────────────

export class ChatAgent {
  private readonly config: ChatAgentConfig;
  private readonly mcp: BalchemyMcpClient;
  private tools: ToolDef[] = [];
  private history: ConversationMessage[] = [];
  private readonly replayFetch: typeof fetch;
  private chatQueue: Promise<void> = Promise.resolve();

  constructor(config: ChatAgentConfig, mcp: BalchemyMcpClient, replayFetch: typeof fetch) {
    this.config = config;
    this.mcp = mcp;
    this.replayFetch = replayFetch;

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
      content: SYSTEM_PROMPT,
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

    let resultText: string;

    if (tc.function.name === "trade_command" && confirmTrade) {
      const intent = String(args.intent ?? args.message ?? "trade");
      const action = String(args.action ?? args.side ?? args.intent ?? "trade");
      const token = String(args.token ?? args.tokenMint ?? args.tokenAddress ?? args.mint ?? "unknown");
      const amount = String(args.amount ?? args.size ?? args.solAmount ?? args.usdAmount ?? "?");
      const chain = String(args.chain ?? args.network ?? "unknown");
      const unit = chain.toLowerCase().includes("base") ? "USD/USDC" : "SOL";
      const preview = `${action.toUpperCase()} ${amount} ${unit} → ${token.slice(0, 18)}`;

      const confirmed = await confirmTrade({
        preview,
        intent,
        action,
        token,
        amount,
        chain,
        rawArgs: args,
      });
      if (!confirmed) {
        resultText = "Trade cancelled by user.";
        onToolCall?.(tc.function.name, resultText);
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

const SYSTEM_PROMPT = `You are a Balchemy autonomous trading agent. You help the user set up and run their crypto trading bot on Solana and Base chains.

You have access to MCP tools via tool calling. Always call tools when you need to take action — never just describe what you would do.

Use only MCP tools that are listed for this session. For runtime, portfolio, open-position, pending-order, context, or activity snapshot requests, use agent_context_snapshot when it is advertised; otherwise use agent_status and clearly say which data is unavailable. For research, portfolio, new launch, trending-token, liquidity-scan, opportunity, candidate, or Turkish prompts such as "tara" / "yeni launch", use the dedicated advertised safe tool when present: agent_market_brief for broad discovery, agent_candidate_report for one specific asset, and agent_risk_report for one specific asset's risk. Use ask_bot only as fallback when no dedicated safe tool is available. Never invent or call tool names that are not available.

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
- Show amounts in SOL.
- Respect the user's rules at all times.
- When a tool is unavailable, rate limited, degraded, or not present in tools/list, state that exact condition and stop. Do not say vague follow-ups like "istersen tekrar deneyebilirim" or "I can try again" unless the user asks you to retry. Give the concrete next diagnostic step instead.
- Never treat missing market/risk/provider data as a safe result. Say unavailable/degraded and do not recommend execution.

## LANGUAGE
Respond in the same language the user writes in. Turkish input → Turkish response. English → English.

Be direct. Don't be verbose. Don't add unnecessary pleasantries.`;
