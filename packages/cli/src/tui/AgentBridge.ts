// src/tui/AgentBridge.ts
import { randomUUID } from "node:crypto";
import { AgentLoop, connectMcp } from "@balchemyai/agent-sdk";
import type { AgentLoopConfig, BalchemyMcpClient } from "@balchemyai/agent-sdk";
import type { ChatMessage, StatusData, TradeInfo, TuiConfig } from "./types.js";
import { ChatAgent } from "./ChatAgent.js";
import { loadAgent } from "../agent-store.js";

/** Truncate verbose API errors (429 JSON blobs, stack traces) to a readable one-liner. */
function truncateError(raw: string): string {
  // Extract HTTP status code if present
  const statusMatch = raw.match(/\b(4\d{2}|5\d{2})\b/);
  const status = statusMatch ? statusMatch[1] : null;

  // Extract retry-after header value if present
  const retryMatch = raw.match(/retry[- ]?after[:\s]*(\d+)/i);
  const retryAfter = retryMatch ? `${retryMatch[1]}s` : null;

  // Strip JSON blobs — everything between first { and last }
  let clean = raw.replace(/\{[\s\S]*\}/g, "").trim();

  // If stripping JSON left us with almost nothing, take first line of original
  if (clean.length < 10) {
    clean = raw.split("\n")[0];
  }

  // Truncate to max 150 chars
  if (clean.length > 150) {
    clean = clean.slice(0, 147) + "...";
  }

  // Build a readable summary
  if (status === "429") {
    return retryAfter
      ? `Rate limited (429). Retry after ${retryAfter}.`
      : "Rate limited (429). Try again in a moment.";
  }

  return clean;
}

type StateSetters = {
  addMessage: (msg: ChatMessage) => void;
  setStatus: (updater: (prev: StatusData) => StatusData) => void;
  confirmTrade: (preview: string) => Promise<boolean>;
};

export class AgentBridge {
  private loop: AgentLoop | null = null;
  private mcp: BalchemyMcpClient;
  private config: TuiConfig;
  private chatAgent: ChatAgent | null = null;
  private readonly setters: StateSetters;
  private readonly replayFetch: typeof fetch;
  private lowBalanceWarned = false;
  private pendingLoopConfig: AgentLoopConfig | null = null;

  constructor(config: TuiConfig, setters: StateSetters) {
    this.config = config;
    this.setters = setters;

    // Replay-protected fetch for MCP calls
    this.replayFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      headers.set("x-request-nonce", `nonce-${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 16)}`);
      headers.set("x-request-timestamp", String(Math.floor(Date.now() / 1000)));
      return fetch(url, { ...init, headers });
    };

    this.mcp = connectMcp({
      endpoint: config.mcpEndpoint,
      apiKey: config.apiKey,
      fetchFn: this.replayFetch,
    });
  }

  /**
   * Start the bridge: init ChatAgent, start AgentLoop + SSE.
   * Returns as soon as the input is ready — the greeting runs in the background.
   */
  async start(): Promise<void> {
    // Init the ChatAgent (external LLM with tool-calling)
    this.chatAgent = new ChatAgent(
      {
        llmProvider: this.config.llmProvider as "anthropic" | "openai",
        llmApiKey: this.config.llmApiKey,
        llmModel: this.config.llmModel,
        llmBaseUrl: this.config.llmBaseUrl,
        llmTimeoutMs: this.config.llmTimeoutMs ?? 30_000,
      },
      this.mcp,
      this.replayFetch,
    );
    await this.chatAgent.init();

    // Check setup status
    const setupComplete = await this.checkSetupStatus();

    const loopConfig: AgentLoopConfig = {
      mcpEndpoint: this.config.mcpEndpoint,
      apiKey: this.config.apiKey,
      llmProvider: this.config.llmProvider as "anthropic" | "openai" | "custom",
      llmApiKey: this.config.llmApiKey,
      llmModel: this.config.llmModel,
      llmBaseUrl: this.config.llmBaseUrl,
      maxDailyLlmCost: this.config.maxDailyLlmCost ?? 5,
      llmTimeoutMs: this.config.llmTimeoutMs ?? 15_000,
      mcpFetchFn: this.replayFetch,

      onEvent: (event) => {
        const data = event.data as Record<string, unknown> | undefined;
        const eventType = data?.subscription_type ?? data?.event_type ?? event.type;
        // Only show subscription events in chat, skip heartbeats/internal
        if (eventType === "subscription_event" || eventType === "subscription_digest") {
          const delta = data?.delta as Record<string, unknown> | undefined;
          const events = (delta?.events ?? []) as Array<Record<string, unknown>>;
          for (const evt of events) {
            const evtData = evt.data as Record<string, unknown> | undefined;
            const mint = String(evtData?.mint ?? evt.key ?? "unknown").slice(0, 8);
            this.addSystemMessage(`New token: ${mint}... (${String(evtData?.launchpad ?? "unknown")})`);
          }
        }
        this.setters.setStatus((prev) => ({ ...prev, eventsReceived: prev.eventsReceived + 1 }));
      },

      onDecision: (decision) => {
        const reasoning = decision.reasoning ?? `${decision.action} ${decision.token ?? ""} ${decision.amount ?? ""}`;
        this.addAgentMessage(reasoning);
        this.setters.setStatus((prev) => ({ ...prev, decisionsExecuted: prev.decisionsExecuted + 1 }));
      },

      onTradeResult: (result) => {
        const trade: TradeInfo = {
          token: result.token ?? "unknown",
          action: result.action as "buy" | "sell",
          amount: result.amount ?? "?",
          timestamp: Date.now(),
        };
        this.addTradeMessage(trade);
        this.setters.setStatus((prev) => ({
          ...prev,
          tradesExecuted: prev.tradesExecuted + 1,
          activeTrades: result.action === "buy"
            ? [...prev.activeTrades, trade]
            : prev.activeTrades.filter((t) => t.token !== trade.token),
        }));
      },

      onError: (err) => {
        this.addErrorMessage(err.message);
      },

      onStatusChange: (status) => {
        this.setters.setStatus((prev) => ({
          ...prev,
          status: status.status,
          llmCostToday: status.llmCostToday,
          sseConnected: status.sseConnected,
          uptime: status.uptime,
        }));
      },
    };

    // Store loop config — may start later after setup completes in-session
    this.pendingLoopConfig = loopConfig;

    // Only start AgentLoop if setup is complete
    if (setupComplete) {
      this.loop = new AgentLoop(loopConfig);
      await this.loop.start();
    }

    // Push provider/model to status panel
    this.setters.setStatus((prev) => ({
      ...prev,
      provider: this.config.llmProvider,
      model: this.config.llmModel,
    }));

    // Input is ready now — kick off greeting + balance check in the background
    void this.greet(setupComplete);
  }

  /** Background greeting after start — does not block input activation. */
  private async greet(setupComplete: boolean): Promise<void> {
    if (!this.chatAgent) return;

    if (setupComplete) {
      await this.checkBalance();
    }

    try {
      const prompt = setupComplete
        ? "Check my portfolio and status, then greet me. Tell me my balance, wallets, and current strategy. Keep it brief."
        : "Agent setup is incomplete. Check setup status with setup_agent get_status, then guide me through the setup. Start by greeting me.";
      const reply = await this.chatAgent.chat(
        prompt,
        (name, _result) => this.addSystemMessage(`Tool: ${name}`),
      );
      this.addAgentMessage(reply);
    } catch (err: unknown) {
      this.addErrorMessage(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    await this.loop?.stop();
    this.loop = null;
    this.chatAgent = null;
  }

  /** Restart with new config — used when settings change (no CLI restart needed). */
  async restart(newConfig: TuiConfig): Promise<void> {
    await this.stop();
    this.config = newConfig;
    this.mcp = connectMcp({
      endpoint: newConfig.mcpEndpoint,
      apiKey: newConfig.apiKey,
      fetchFn: this.replayFetch,
    });
    await this.start();
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.chatAgent) return;
    this.setters.addMessage({
      id: randomUUID(),
      type: "user",
      text,
      timestamp: Date.now(),
    });
    try {
      const reply = await this.chatAgent.chat(
        text,
        (name, _result) => this.addSystemMessage(`Tool: ${name}`),
        (preview) => this.setters.confirmTrade(preview),
      );
      this.addAgentMessage(reply);

      // After each message, check if setup just completed — start loop if so
      await this.tryStartLoop();
    } catch (err: unknown) {
      this.addErrorMessage(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Start AgentLoop if setup just completed during this session. */
  private async tryStartLoop(): Promise<void> {
    if (this.loop || !this.pendingLoopConfig) return;
    const nowComplete = await this.checkSetupStatus();
    if (nowComplete) {
      this.loop = new AgentLoop(this.pendingLoopConfig);
      await this.loop.start();
      this.addSystemMessage("Agent loop started — now listening for events.");
      this.setters.setStatus((prev) => ({ ...prev, sseConnected: true, status: "running" }));
      void this.checkBalance();
    }
  }

  /** Check if setup is complete. Returns true if ready to trade, false if needs setup. */
  private async checkSetupStatus(): Promise<boolean> {
    try {
      const resp = await this.mcp.callTool("setup_agent", { action: "get_status" });
      const text = resp.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = {}; }
      const structured = parsed.structured as Record<string, unknown> | undefined;
      return structured?.tradingConfigured === true && structured?.walletsConfigured === true;
    } catch {
      return false;
    }
  }

  /** Silent balance refresh — updates status panel only, no chat messages. */
  async refreshBalance(): Promise<void> {
    try {
      const response = await this.mcp.agentPortfolio();
      const text = response.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = {}; }
      const sol = Number(parsed.totalValueSol ?? 0);
      const usd = Number(parsed.totalValueUsd ?? 0);
      // Extract wallet addresses if present
      const wallets: Array<{ chain: "solana" | "base"; address: string }> = [];
      const walletsArr = parsed.wallets as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(walletsArr)) {
        for (const w of walletsArr) {
          if (w.chain && w.address) {
            wallets.push({ chain: w.chain as "solana" | "base", address: String(w.address) });
          }
        }
      }
      this.setters.setStatus((prev) => ({
        ...prev,
        balanceSol: sol,
        balanceUsd: usd,
        ...(wallets.length > 0 ? { wallets } : {}),
      }));
    } catch {
      // Silent — don't spam chat
    }
  }

  async checkBalance(): Promise<void> {
    try {
      const response = await this.mcp.agentPortfolio();
      const text = response.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = {}; }
      const sol = Number(parsed.totalValueSol ?? 0);
      const usd = Number(parsed.totalValueUsd ?? 0);
      this.setters.setStatus((prev) => ({ ...prev, balanceSol: sol, balanceUsd: usd }));
      if (sol < 0.01 && !this.lowBalanceWarned) {
        this.lowBalanceWarned = true;
        this.addErrorMessage(`Wallet balance too low (${sol} SOL). Fund your Solana wallet to start trading.`);
      }
      if (sol >= 0.01) {
        this.lowBalanceWarned = false;
      }
    } catch {
      this.addErrorMessage("Could not check wallet balance.");
    }
  }

  // ── Settings helpers (for /settings menu) ─────────────────────────────────

  /** Fetch server-side settings (slippage, strategy) from MCP. */
  async fetchRemoteSettings(): Promise<{ slippageBps?: number; strategy?: string }> {
    const result: { slippageBps?: number; strategy?: string } = {};

    // Try get_behavior_rules for strategy/rules info
    try {
      const resp = await this.mcp.callTool("get_behavior_rules", {});
      const text = resp.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = {}; }
      const structured = parsed.structured as Record<string, unknown> | undefined;
      const rules = structured ?? parsed;

      // Extract slippage from rules
      if (typeof rules.defaultSlippageBps === "number") {
        result.slippageBps = rules.defaultSlippageBps;
      }
      // Extract strategy description
      if (typeof rules.naturalLanguageRules === "string" && rules.naturalLanguageRules) {
        result.strategy = rules.naturalLanguageRules;
      } else if (typeof rules.preset === "string") {
        result.strategy = `preset: ${rules.preset}`;
      }
    } catch {
      // Fallback: try setup_agent get_status for boolean flags
      try {
        const resp = await this.mcp.callTool("setup_agent", { action: "get_status" });
        const text = resp.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch { parsed = {}; }
        const structured = parsed.structured as Record<string, unknown> | undefined;
        if (structured?.slippageConfigured) result.slippageBps = result.slippageBps ?? undefined;
        if (structured?.strategyConfigured) result.strategy = result.strategy ?? "configured";
      } catch {
        // Silent
      }
    }

    return result;
  }

  /** Update slippage on the server via MCP. Returns false if backend rejected (e.g. STEP_ORDER). */
  async updateSlippage(bps: number): Promise<boolean> {
    try {
      const resp = await this.mcp.callTool("setup_agent", { action: "configure_slippage", slippageBps: bps });
      return !this.isToolError(resp);
    } catch {
      return false;
    }
  }

  /** Update strategy on the server via MCP. Returns false if backend rejected. */
  async updateStrategy(rules: string): Promise<boolean> {
    try {
      const resp = await this.mcp.callTool("setup_agent", {
        action: "configure_autonomous",
        naturalLanguageRules: rules,
        shadowMode: false,
      });
      return !this.isToolError(resp);
    } catch {
      return false;
    }
  }

  /** Check if MCP tool response contains a backend error (ToolError returned as success). */
  private isToolError(resp: { content?: Array<{ type: string; text?: string }> }): boolean {
    const text = resp.content?.find((c) => c.type === "text")?.text ?? "";
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed.ok === false) return true;
      const structured = parsed.structured as Record<string, unknown> | undefined;
      if (structured?.error) return true;
    } catch { /* not JSON */ }
    return false;
  }

  /** Get current local config for settings display. Reads from disk to catch recent saves. */
  getLocalConfig(): { provider: string; model: string; maxDailyCost: number } {
    const saved = loadAgent();
    if (saved) {
      return {
        provider: saved.llmProvider ?? this.config.llmProvider,
        model: saved.llmModel ?? this.config.llmModel ?? "(default)",
        maxDailyCost: saved.maxDailyLlmCost ?? this.config.maxDailyLlmCost ?? 5,
      };
    }
    return {
      provider: this.config.llmProvider,
      model: this.config.llmModel ?? "(default)",
      maxDailyCost: this.config.maxDailyLlmCost ?? 5,
    };
  }

  // ── Convenience helpers ──────────────────────────────────────────────────

  private addAgentMessage(text: string): void {
    this.setters.addMessage({ id: randomUUID(), type: "agent", text, timestamp: Date.now() });
  }
  private addSystemMessage(text: string): void {
    this.setters.addMessage({ id: randomUUID(), type: "system", text, timestamp: Date.now() });
  }
  private addTradeMessage(trade: TradeInfo): void {
    this.setters.addMessage({
      id: randomUUID(),
      type: "trade",
      text: `${trade.amount} SOL ${trade.action === "buy" ? "\u2192" : "\u2190"} ${trade.token.slice(0, 8)}...`,
      token: trade.token,
      action: trade.action,
      amount: trade.amount,
      timestamp: Date.now(),
    });
  }
  private addErrorMessage(text: string): void {
    // Truncate long error messages — extract status code and first meaningful line
    const truncated = truncateError(text);
    this.setters.addMessage({ id: randomUUID(), type: "error", text: truncated, timestamp: Date.now() });
  }
}
