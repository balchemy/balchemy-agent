/**
 * ChatAgent — External LLM with MCP tool-calling capability.
 *
 * Instead of ask_bot (which uses the internal servant LLM),
 * this calls the user's chosen LLM directly with the MCP tool
 * definitions. The LLM can then call setup_agent, trade_command,
 * etc. — exactly like Claude Desktop or OpenCode.
 *
 * Flow:
 *   User message → External LLM (with tools) → tool call?
 *   → Execute via MCP → feed result back → repeat until text response
 */

import { randomUUID } from "node:crypto";
import type { BalchemyMcpClient } from "@balchemyai/agent-sdk";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ConversationMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
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
    confirmTrade?: (preview: string, args: Record<string, unknown>) => Promise<boolean>,
  ): Promise<string> {
    return this.enqueueChat(() => this.runChat(userMessage, onToolCall, confirmTrade));
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
    confirmTrade?: (preview: string, args: Record<string, unknown>) => Promise<boolean>,
  ): Promise<string> {
    this.history.push({ role: "user", content: userMessage });

    // Loop: call LLM → if tool calls, execute them → feed back → repeat
    const MAX_ROUNDS = 10;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response = await this.callLlm();

      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Pure text response — done
        this.history.push({ role: "assistant", content: response.text });
        return response.text;
      }

      // LLM wants to call tools
      this.history.push({
        role: "assistant",
        content: response.text || "",
        tool_calls: response.toolCalls,
      });

      // Execute each tool call
      for (const tc of response.toolCalls) {
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          args = {};
        }

        let resultText: string;

        // Intercept trade_command for confirmation
        if (tc.function.name === "trade_command" && confirmTrade) {
          const intent = String(args.intent ?? args.message ?? "trade");
          const token = String(args.token ?? "").slice(0, 12);
          const amount = String(args.amount ?? "?");
          const preview = `${intent.toUpperCase()} ${amount} SOL → ${token || "unknown"}`;

          const confirmed = await confirmTrade(preview, args);
          if (!confirmed) {
            resultText = "Trade cancelled by user.";
            onToolCall?.(tc.function.name, resultText);
            this.history.push({ role: "tool", content: resultText, tool_call_id: tc.id });
            continue;
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
      }
    }

    return "I hit the tool-call limit. Please try a simpler request.";
  }

  // ── LLM Call ──────────────────────────────────────────────────────────────

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

## SETUP FLOW

When setup is incomplete, first call setup_agent with action="get_status". Then guide the user in chat, one question at a time. Do NOT run a separate terminal wizard and do NOT skip steps.

### Step 1: Bind developer wallet
- Ask for their Base/EVM 0x developer wallet. Explain this is the recovery/Hub/withdrawal wallet; Solana/Base trading wallets are created separately in the next step.
- Ask them to paste the same 0x address again only if you need confirmation.
- Call: setup_agent { action: "bind_developer_wallet", walletAddress: "<their address>", walletAddressConfirm: "<their address>" }
- Tell them their master key from the response. Say clearly that it is shown only once and must be saved.

### Step 2: Choose trading networks and create wallets
- Ask: "Which networks should this agent trade on: Solana, Base (EVM), or both?"
- If they choose Solana, call: setup_agent { action: "create_wallet", chain: "solana" }
- If they choose Base/EVM, call: setup_agent { action: "create_wallet", chain: "base" }
- If they choose both, call both tool actions sequentially and show both addresses.
- Funding guidance: Solana needs SOL in the Solana wallet; Base needs ETH in the Base wallet for gas and tokens.

### Step 3: Configure slippage
- Ask for slippage in percent or basis points. Explain: 1% = 100 bps, 3% = 300 bps, 5% = 500 bps.
- If the user answers a plain number like "5" while discussing percent/slippage, treat it as 5% = 500 bps unless they explicitly say "5 bps".
- Call: setup_agent { action: "configure_slippage", slippageBps: <converted bps> }

### Step 4: Configure hard limits and strategy
- Ask for max per-trade limits for the selected networks: max SOL per trade for Solana and/or max USD per trade for Base/EVM.
- Ask for the natural-language strategy, including entry filters, stop loss, take profit, max concurrent positions and any tokens/categories to avoid.
- Repeat the final strategy back and ask for confirmation before configuring.
- Call: setup_agent { action: "configure_autonomous", shadowMode: false, naturalLanguageRules: "<their exact words>", maxTradeSol: <if provided>, maxTradeUsd: <if provided> }
- NEVER set shadowMode to true. All trading is LIVE.

### Step 5: Configure event monitoring
- Based on the selected networks and strategy, ask whether to create monitoring subscriptions now.
- For Solana memecoin/new launch strategies, call create_subscription with type="new_token_launch", chain="solana", filter platform="pumpfun" unless the user asks otherwise.
- For Base/EVM strategies, prefer price/volume subscriptions supported by the tool list and ask the user which assets or filters to monitor.

### Step 6: Done
- Tell them setup is complete. Show a summary: selected networks, wallet addresses, slippage, hard limits, strategy and subscriptions.
- Tell them you're now listening for events and ready to trade.

## IMPORTANT RULES
- shadowMode is ALWAYS false. Never enable it.
- Complete ALL setup steps before trading.
- Always show wallet addresses and master key to the user.
- Ask questions and wait for answers — don't rush through setup.
- When the user tells you their strategy, repeat it back to confirm before configuring.
- Never assume both chains. Ask Solana/Base/both, then create only the selected chain wallets.

## TRADING BEHAVIOR (after setup)
- Explain every decision: what token you found, why it matches their strategy, what you're doing.
- Keep it to 1-3 sentences per decision.
- Show amounts in SOL.
- Respect the user's rules at all times.

## LANGUAGE
Respond in the same language the user writes in. Turkish input → Turkish response. English → English.

Be direct. Don't be verbose. Don't add unnecessary pleasantries.`;
