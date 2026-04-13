// src/tui/AgentBridge.ts
import { randomUUID } from "node:crypto";
import { AgentLoop, connectMcp } from "@balchemy/agent-sdk";
import type { AgentLoopConfig, BalchemyMcpClient } from "@balchemy/agent-sdk";
import type { ChatMessage, StatusData, TradeInfo, TuiConfig } from "./types.js";
import { ChatAgent } from "./ChatAgent.js";

type StateSetters = {
  addMessage: (msg: ChatMessage) => void;
  setStatus: (updater: (prev: StatusData) => StatusData) => void;
};

export class AgentBridge {
  private loop: AgentLoop | null = null;
  private readonly mcp: BalchemyMcpClient;
  private readonly config: TuiConfig;
  private chatAgent: ChatAgent | null = null;
  private readonly setters: StateSetters;
  private readonly replayFetch: typeof fetch;
  private lowBalanceWarned = false;

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
        llmProvider: this.config.llmProvider,
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
      llmProvider: this.config.llmProvider,
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

    this.loop = new AgentLoop(loopConfig);
    await this.loop.start();

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
      this.addErrorMessage(`Greeting failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    await this.loop?.stop();
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
      );
      this.addAgentMessage(reply);
    } catch (err: unknown) {
      this.addErrorMessage(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
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
      this.setters.setStatus((prev) => ({ ...prev, balanceSol: sol, balanceUsd: usd }));
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

  // Convenience helpers
  private addAgentMessage(text: string): void {
    this.setters.addMessage({ id: randomUUID(), type: "agent", text, timestamp: Date.now() });
  }
  private addSystemMessage(text: string): void {
    this.setters.addMessage({ id: randomUUID(), type: "system", text, timestamp: Date.now() });
  }
  private addTradeMessage(trade: TradeInfo): void {
    const icon = trade.action === "buy" ? "BUY" : "SELL";
    this.setters.addMessage({
      id: randomUUID(),
      type: "trade",
      text: `${icon} ${trade.amount} SOL ${trade.action === "buy" ? "->" : "<-"} ${trade.token.slice(0, 8)}...`,
      token: trade.token,
      action: trade.action,
      amount: trade.amount,
      timestamp: Date.now(),
    });
  }
  private addErrorMessage(text: string): void {
    this.setters.addMessage({ id: randomUUID(), type: "error", text, timestamp: Date.now() });
  }
}
