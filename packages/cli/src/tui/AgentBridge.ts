// src/tui/AgentBridge.ts
import { randomUUID } from "node:crypto";
import { AgentLoop, connectMcp } from "@balchemyai/agent-sdk";
import type { AgentLoopConfig, BalchemyMcpClient } from "@balchemyai/agent-sdk";
import type { ChatMessage, StatusData, TradeInfo, TuiConfig, WalletInfo } from "./types.js";
import { ChatAgent } from "./ChatAgent.js";
import {
  buildSetupRequiredMessage,
  getInitialSetupStep,
  isSetupReady,
  parseNetworkSelection,
  parseSetupStatusSnapshot,
  type SetupStatusSnapshot,
} from "./setup-guidance.js";
import { buildStrategyUpdateArgs } from "./session-sync.js";
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

function resolveProviderLabel(provider: string, baseUrl?: string): string {
  if (provider === "anthropic") return "anthropic";
  if (baseUrl?.includes("generativelanguage.googleapis.com")) return "gemini";
  if (baseUrl?.includes("api.x.ai")) return "grok";
  if (baseUrl?.includes("openrouter.ai")) return "openrouter";
  return "openai";
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch (_error: unknown) {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function firstNumber(source: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function normalizeChain(value: unknown): WalletInfo["chain"] | null {
  const raw = String(value ?? "").toLowerCase();
  if (raw === "sol" || raw === "solana" || raw === "solana-devnet" || raw === "devnet") return "solana";
  if (raw === "base" || raw === "base-sepolia" || raw === "evm" || raw === "ethereum" || raw === "eth" || raw === "eip155" || raw === "1" || raw === "8453" || raw === "84532") return "base";
  return null;
}

function readWallet(value: unknown): WalletInfo | null {
  const record = asRecord(value);
  if (!record) return null;
  const walletRecord = asRecord(record.wallet);
  const address = firstString(
    record.address,
    record.walletAddress,
    record.publicAddress,
    record.publicKey,
    record.custodialWalletAddress,
    walletRecord?.address,
    walletRecord?.walletAddress,
    walletRecord?.publicAddress,
    walletRecord?.publicKey,
    walletRecord?.custodialWalletAddress,
  );
  const chain = normalizeChain(record.chain ?? record.network ?? record.chainId ?? walletRecord?.chain ?? walletRecord?.network ?? walletRecord?.chainId);
  if (!address || !chain) return null;
  return { chain, address };
}

function mergeWallets(...groups: WalletInfo[][]): WalletInfo[] {
  const wallets: WalletInfo[] = [];
  for (const group of groups) {
    for (const wallet of group) {
      if (!wallets.some((existing) => existing.chain === wallet.chain && existing.address === wallet.address)) {
        wallets.push(wallet);
      }
    }
  }
  return wallets;
}

function readRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    return record ? [record] : [];
  });
}

function collectWallets(source: Record<string, unknown>): WalletInfo[] {
  const wallets: WalletInfo[] = [];
  const push = (wallet: WalletInfo | null): void => {
    if (!wallet) return;
    if (!wallets.some((existing) => existing.chain === wallet.chain && existing.address === wallet.address)) {
      wallets.push(wallet);
    }
  };

  for (const key of ["wallets", "tradingWallets", "custodialWallets", "walletBalances"]) {
    const value = source[key];
    if (Array.isArray(value)) {
      for (const item of value) push(readWallet(item));
    } else {
      const record = asRecord(value);
      if (record) {
        for (const [chain, addressOrWallet] of Object.entries(record)) {
          const normalized = normalizeChain(chain);
          if (typeof addressOrWallet === "string") {
            if (normalized) push({ chain: normalized, address: addressOrWallet });
          } else {
            push(readWallet({ ...(asRecord(addressOrWallet) ?? {}), chain }));
          }
        }
      }
    }
  }

  const solanaAddress = source.solanaWalletAddress ?? source.solanaWallet ?? source.solWallet;
  if (typeof solanaAddress === "string") push({ chain: "solana", address: solanaAddress });
  const baseAddress = source.baseWalletAddress ?? source.baseWallet ?? source.evmWallet;
  if (typeof baseAddress === "string") push({ chain: "base", address: baseAddress });

  const funding = asRecord(source.funding);
  if (funding) {
    push(readWallet({
      address: funding.custodialWalletAddress ?? funding.address,
      chain: funding.chain ?? funding.chainId ?? "base",
    }));
  }

  for (const key of ["status", "setupStatus", "data", "snapshot", "portfolio"]) {
    const nested = asRecord(source[key]);
    if (nested) {
      for (const wallet of collectWallets(nested)) push(wallet);
    }
  }

  return wallets;
}

function readTokenHumanAmount(value: unknown): number | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  return firstNumber(record, ["human", "amount", "balance"]);
}

function sumWalletBalances(source: Record<string, unknown>): { balanceSol?: number; balanceUsd?: number } {
  const balances = readRecords(source.walletBalances);
  let balanceSol = 0;
  let hasSol = false;
  let balanceUsd = 0;
  let hasUsd = false;

  for (const balance of balances) {
    const baseSymbol = String(balance.baseSymbol ?? balance.symbol ?? "").toUpperCase();
    const stableSymbol = String(balance.stableSymbol ?? "").toUpperCase();
    const baseBalance = firstNumber(balance, ["baseBalance", "nativeBalance", "balance"]);
    const stableBalance = firstNumber(balance, ["stableBalance", "usdcBalance"]);
    const valueUsd = firstNumber(balance, ["valueUsd", "value_usd", "usdValue"]);

    if ((baseSymbol === "SOL" || balance.chain === "solana") && baseBalance !== undefined) {
      balanceSol += baseBalance;
      hasSol = true;
    }
    if ((stableSymbol === "USDC" || stableSymbol === "USD") && stableBalance !== undefined) {
      balanceUsd += stableBalance;
      hasUsd = true;
    } else if (valueUsd !== undefined) {
      balanceUsd += valueUsd;
      hasUsd = true;
    }
  }

  const wallets = asRecord(source.wallets);
  if (wallets) {
    for (const walletValue of Object.values(wallets)) {
      const wallet = asRecord(walletValue);
      const walletBalances = asRecord(wallet?.balances);
      if (!walletBalances) continue;
      for (const [symbol, tokenBalance] of Object.entries(walletBalances)) {
        const amount = readTokenHumanAmount(tokenBalance);
        if (amount === undefined) continue;
        const upperSymbol = symbol.toUpperCase();
        if (upperSymbol === "SOL") {
          balanceSol += amount;
          hasSol = true;
        }
        if (upperSymbol === "USDC" || upperSymbol === "TUSD" || upperSymbol === "USD") {
          balanceUsd += amount;
          hasUsd = true;
        }
      }
    }
  }

  return {
    ...(hasSol ? { balanceSol } : {}),
    ...(hasUsd ? { balanceUsd } : {}),
  };
}

function collectPositions(source: Record<string, unknown>): TradeInfo[] | null {
  if (!Array.isArray(source.positions)) return null;
  return readRecords(source.positions).flatMap((position) => {
    const token = String(position.tokenMint ?? position.tokenAddress ?? position.tokenSymbol ?? "");
    if (!token) return [];
    const amount = String(position.netAmount ?? position.amount ?? position.balance ?? "?");
    return [{ token, action: "buy" as const, amount, timestamp: Date.now() }];
  });
}

type StateSetters = {
  addMessage: (msg: ChatMessage) => void;
  setStatus: (updater: (prev: StatusData) => StatusData) => void;
  confirmTrade: (preview: string) => Promise<boolean>;
};

type SetupStep =
  | "developer-wallet"
  | "developer-wallet-confirm"
  | "networks"
  | "solana-recovery-wallet"
  | "solana-recovery-wallet-confirm"
  | "slippage"
  | "strategy"
  | "strategy-confirm"
  | "subscriptions";

interface SetupFlowState {
  step: SetupStep;
  developerWallet?: string;
  solanaRecoveryWallet?: string;
  selectedChains?: WalletInfo["chain"][];
  slippageBps?: number;
  strategyText?: string;
  chainStrategies?: Partial<Record<WalletInfo["chain"], string>>;
  currentStrategyChain?: WalletInfo["chain"];
  maxTradeSol?: number;
  maxTradeUsd?: number;
}

function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

function isSolanaAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value.trim());
}

function isAffirmative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["y", "yes", "yep", "yeah", "evet", "ok", "okay", "tamam", "onay", "onayliyorum"].includes(normalized);
}

function isNegative(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ["n", "no", "nope", "hayir", "hayir istemiyorum", "iptal", "degistir"].includes(normalized);
}

function parseSlippageBps(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  const match = normalized.match(/([0-9]+(?:[.,][0-9]+)?)/);
  if (!match) return null;
  const numeric = Number(match[1].replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  const explicitBps = /\b(bps|basis)\b/.test(normalized);
  const bps = explicitBps ? Math.round(numeric) : Math.round(numeric * 100);
  if (bps < 1 || bps > 5_000) return null;
  return bps;
}

function parseTradeLimits(value: string): { maxTradeSol?: number; maxTradeUsd?: number } {
  const solMatch = value.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:sol)\b/i);
  const usdMatch = value.match(/(?:\$|usd\s*)\s*([0-9]+(?:[.,][0-9]+)?)/i)
    ?? value.match(/([0-9]+(?:[.,][0-9]+)?)\s*(?:usd|usdc|dollar)\b/i);
  const maxTradeSol = solMatch ? Number(solMatch[1].replace(",", ".")) : undefined;
  const maxTradeUsd = usdMatch ? Number(usdMatch[1].replace(",", ".")) : undefined;
  return {
    ...(maxTradeSol !== undefined && Number.isFinite(maxTradeSol) ? { maxTradeSol } : {}),
    ...(maxTradeUsd !== undefined && Number.isFinite(maxTradeUsd) ? { maxTradeUsd } : {}),
  };
}

function formatChains(chains: WalletInfo["chain"][]): string {
  return chains.map((chain) => chain === "solana" ? "Solana" : "Base").join(" + ");
}

function chainTitle(chain: WalletInfo["chain"]): string {
  return chain === "solana" ? "Solana" : "Base";
}

function extractMasterKey(source: Record<string, unknown>): string | null {
  const direct = firstString(source.masterKey, source.master_key);
  if (direct) return direct;
  const reply = firstString(source.reply, source.message);
  if (!reply) return null;
  const match = reply.match(/master key(?:\s+is)?\s*:\s*([^\s—]+)/i);
  return match?.[1] ?? null;
}

function buildCombinedStrategy(flow: SetupFlowState): string {
  if (flow.strategyText) return flow.strategyText;
  const chainStrategies = flow.chainStrategies ?? {};
  const parts: string[] = [];
  if (chainStrategies.solana) parts.push(`Solana strategy:\n${chainStrategies.solana}`);
  if (chainStrategies.base) parts.push(`Base strategy:\n${chainStrategies.base}`);
  return parts.join("\n\n");
}

function nextStrategyChain(
  chains: WalletInfo["chain"][],
  chainStrategies: Partial<Record<WalletInfo["chain"], string>>,
): WalletInfo["chain"] | null {
  return chains.find((chain) => !chainStrategies[chain]) ?? null;
}

export class AgentBridge {
  private loop: AgentLoop | null = null;
  private mcp: BalchemyMcpClient;
  private config: TuiConfig;
  private chatAgent: ChatAgent | null = null;
  private readonly setters: StateSetters;
  private readonly replayFetch: typeof fetch;
  private lowBalanceWarned = false;
  private pendingLoopConfig: AgentLoopConfig | null = null;
  private setupPollTimer: NodeJS.Timeout | null = null;
  private setupFlow: SetupFlowState | null = null;

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
    const setupStatus = await this.fetchSetupStatus();
    const setupComplete = this.isSetupComplete(setupStatus);

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
      behaviorRules: this.config.behaviorRules,

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
      this.setters.setStatus((prev) => ({ ...prev, status: "connecting" }));
      await this.ensureDefaultSubscriptions();
      this.loop = new AgentLoop(loopConfig);
      await this.loop.start();
    } else {
      this.setters.setStatus((prev) => ({
        ...prev,
        sseConnected: false,
        status: "setup-required",
      }));
      this.startSetupPolling();
    }

    // Push provider/model to status panel
    this.setters.setStatus((prev) => ({
      ...prev,
      provider: resolveProviderLabel(this.config.llmProvider, this.config.llmBaseUrl),
      model: this.config.llmModel,
    }));

    // Input is ready now. Setup must be deterministic; do not let an LLM drive it.
    if (setupComplete) {
      void this.greet(true);
    } else {
      this.beginSetupFlow(setupStatus);
    }
  }

  /** Background greeting after start — does not block input activation. */
  private async greet(setupComplete: boolean): Promise<void> {
    if (!this.chatAgent) return;

    if (setupComplete) {
      await this.checkBalance();
    }

    try {
      const prompt = "Check my portfolio and status, then greet me. Tell me my balance, wallets, and current strategy. Keep it brief and do not narrate tool calls.";
      const reply = await this.chatAgent.chat(
        prompt,
        (name, result) => {
          this.applyToolResult(name, result);
          if (name !== "setup_agent") {
            this.addSystemMessage(`Tool: ${name}`);
          }
        },
      );
      this.addAgentMessage(reply);
    } catch (err: unknown) {
      this.addErrorMessage(`LLM error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async stop(): Promise<void> {
    if (this.setupPollTimer) {
      clearInterval(this.setupPollTimer);
      this.setupPollTimer = null;
    }
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
    this.setters.addMessage({
      id: randomUUID(),
      type: "user",
      text,
      timestamp: Date.now(),
    });

    if (this.setupFlow) {
      await this.handleSetupInput(text);
      return;
    }

    if (!this.chatAgent) return;
    try {
      const reply = await this.chatAgent.chat(
        text,
        (name, result) => {
          this.applyToolResult(name, result);
          this.addSystemMessage(`Tool: ${name}`);
        },
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
    if (this.loop || !this.pendingLoopConfig || this.setupFlow) return;
    const setupStatus = await this.fetchSetupStatus();
    const nowComplete = this.isSetupComplete(setupStatus);
    if (nowComplete) {
      await this.ensureDefaultSubscriptions();
      this.loop = new AgentLoop(this.pendingLoopConfig);
      await this.loop.start();
      if (this.setupPollTimer) {
        clearInterval(this.setupPollTimer);
        this.setupPollTimer = null;
      }
      this.addSystemMessage("Agent loop started — now listening for events.");
      this.setters.setStatus((prev) => ({ ...prev, sseConnected: true, status: "running" }));
      void this.checkBalance();
    }
  }

  private startSetupPolling(): void {
    if (this.setupPollTimer) return;
    this.setupPollTimer = setInterval(() => {
      void this.tryStartLoop();
    }, 10_000);
    this.setupPollTimer.unref();
  }

  private beginSetupFlow(status: SetupStatusSnapshot | null): void {
    const snapshot = status ?? {};
    const step = getInitialSetupStep(snapshot);
    this.setupFlow = {
      step,
      ...(snapshot.selectedChains && snapshot.selectedChains.length > 0 ? { selectedChains: snapshot.selectedChains } : {}),
    };

    this.addAgentMessage(
      `${buildSetupRequiredMessage(snapshot)}\n\n${this.setupPromptFor(this.setupFlow.step)}`,
    );
  }

  private setupPromptFor(step: SetupStep): string {
    switch (step) {
      case "developer-wallet":
        return "Paste your Base/EVM 0x developer wallet. This is the recovery, Hub, and withdrawal wallet. Trading wallets are created separately.";
      case "developer-wallet-confirm":
        return "Paste the same 0x developer wallet again to confirm it.";
      case "networks":
        return "Which networks should this agent trade on: Solana, Base, or both?";
      case "solana-recovery-wallet":
        return "Paste your Solana recovery/withdrawal wallet address. This is where SOL/SPL withdrawals go, and it is separate from the Solana trading wallet I create for execution.";
      case "solana-recovery-wallet-confirm":
        return "Paste the same Solana recovery/withdrawal wallet again to confirm it.";
      case "slippage":
        return "Set slippage in percent or bps. Examples: 1% = 100 bps, 3% = 300 bps, 5% = 500 bps.";
      case "strategy":
        return "Send the hard limits and strategy for this chain. Include max trade size, entry filters, stop loss, take profit, max positions, and tokens/categories to avoid.";
      case "strategy-confirm":
        return "Confirm with 'yes'/'evet', or say 'no'/'hayir' to rewrite the strategy.";
      case "subscriptions":
        return "Create monitoring subscriptions now? For Solana new launches I can enable launch monitoring. Answer yes/evet or no/hayir.";
    }
  }

  private async handleSetupInput(text: string): Promise<void> {
    const flow = this.setupFlow;
    if (!flow) return;

    try {
      if (flow.step === "developer-wallet") {
        const wallet = text.trim();
        if (!isEvmAddress(wallet)) {
          this.addAgentMessage("That is not a valid 0x EVM address. Paste a Base/EVM wallet like 0x...");
          return;
        }
        this.setupFlow = { ...flow, step: "developer-wallet-confirm", developerWallet: wallet };
        this.addAgentMessage(this.setupPromptFor("developer-wallet-confirm"));
        return;
      }

      if (flow.step === "developer-wallet-confirm") {
        const wallet = text.trim();
        if (!flow.developerWallet || wallet.toLowerCase() !== flow.developerWallet.toLowerCase()) {
          this.setupFlow = { step: "developer-wallet" };
          this.addAgentMessage("The confirmation did not match. Start again by pasting the Base/EVM 0x developer wallet.");
          return;
        }
        const structured = await this.callSetupAgent({
          action: "bind_developer_wallet",
          walletAddress: flow.developerWallet,
          walletAddressConfirm: wallet,
        });
        const masterKey = extractMasterKey(structured);
        this.setupFlow = { step: "networks" };
        this.addAgentMessage(
          masterKey
            ? `Developer wallet bound.\n\nCopy and store this master key now:\n${masterKey}\n\nIt is shown once in real environments.\n\n${this.setupPromptFor("networks")}`
            : `Developer wallet bound.\n\n${this.setupPromptFor("networks")}`,
        );
        return;
      }

      if (flow.step === "networks") {
        const chains = parseNetworkSelection(text);
        if (!chains) {
          this.addAgentMessage("Choose Solana, Base, or both.");
          return;
        }
        const walletLines: string[] = [];
        for (const chain of chains) {
          const structured = await this.callSetupAgent({ action: "create_wallet", chain });
          const address = firstString(structured.address, asRecord(structured.wallet)?.address);
          walletLines.push(`${chainTitle(chain)} trading wallet: ${address ?? "(created)"}`);
        }
        this.setupFlow = {
          step: chains.includes("solana") ? "solana-recovery-wallet" : "slippage",
          selectedChains: chains,
        };
        this.addAgentMessage(
          `Trading networks configured: ${formatChains(chains)}.\n\nCopyable trading wallet addresses:\n${walletLines.join("\n")}\n\n${this.setupPromptFor(chains.includes("solana") ? "solana-recovery-wallet" : "slippage")}`,
        );
        return;
      }

      if (flow.step === "solana-recovery-wallet") {
        const wallet = text.trim();
        if (!isSolanaAddress(wallet)) {
          this.addAgentMessage("That is not a valid Solana wallet address. Paste a base58 Solana public key.");
          return;
        }
        this.setupFlow = { ...flow, step: "solana-recovery-wallet-confirm", solanaRecoveryWallet: wallet };
        this.addAgentMessage(this.setupPromptFor("solana-recovery-wallet-confirm"));
        return;
      }

      if (flow.step === "solana-recovery-wallet-confirm") {
        const wallet = text.trim();
        if (!flow.solanaRecoveryWallet || wallet !== flow.solanaRecoveryWallet) {
          this.setupFlow = {
            step: "solana-recovery-wallet",
            ...(flow.developerWallet ? { developerWallet: flow.developerWallet } : {}),
            ...(flow.selectedChains ? { selectedChains: flow.selectedChains } : {}),
          };
          this.addAgentMessage("The Solana wallet confirmation did not match. Paste the Solana recovery/withdrawal wallet again.");
          return;
        }
        try {
          await this.callSetupAgent({
            action: "bind_solana_developer_wallet",
            solanaWalletAddress: flow.solanaRecoveryWallet,
            solanaWalletAddressConfirm: wallet,
          });
        } catch (err: unknown) {
          this.addSystemMessage(`Solana recovery wallet stored locally for this setup. MCP did not bind it directly: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.setupFlow = { ...flow, step: "slippage", solanaRecoveryWallet: wallet };
        this.addAgentMessage(`Solana recovery/withdrawal wallet confirmed:\n${wallet}\n\n${this.setupPromptFor("slippage")}`);
        return;
      }

      if (flow.step === "slippage") {
        const bps = parseSlippageBps(text);
        if (bps === null) {
          this.addAgentMessage("I could not parse that slippage. Send a value like 3%, 300 bps, or 5.");
          return;
        }
        await this.callSetupAgent({ action: "configure_slippage", slippageBps: bps });
        const selectedChains = flow.selectedChains ?? ["solana"];
        const currentStrategyChain = nextStrategyChain(selectedChains, {}) ?? selectedChains[0];
        this.setupFlow = { ...flow, step: "strategy", slippageBps: bps, currentStrategyChain, chainStrategies: {} };
        this.addAgentMessage(`Slippage set to ${bps} bps.\n\n${chainTitle(currentStrategyChain)} strategy:\n${this.setupPromptFor("strategy")}`);
        return;
      }

      if (flow.step === "strategy") {
        const strategyText = text.trim();
        if (strategyText.length < 20) {
          this.addAgentMessage("The strategy is too short. Include limits, entries, exits, max positions, and avoid rules.");
          return;
        }
        const chainStrategies = {
          ...(flow.chainStrategies ?? {}),
          ...(flow.currentStrategyChain ? { [flow.currentStrategyChain]: strategyText } : {}),
        };
        const selectedChains = flow.selectedChains ?? (flow.currentStrategyChain ? [flow.currentStrategyChain] : ["solana"]);
        const nextChain = nextStrategyChain(selectedChains, chainStrategies);
        if (nextChain) {
          this.setupFlow = { ...flow, chainStrategies, currentStrategyChain: nextChain };
          this.addAgentMessage(`${chainTitle(flow.currentStrategyChain ?? selectedChains[0])} strategy saved.\n\n${chainTitle(nextChain)} strategy:\n${this.setupPromptFor("strategy")}`);
          return;
        }
        const combinedStrategy = buildCombinedStrategy({ ...flow, chainStrategies });
        const limits = parseTradeLimits(combinedStrategy);
        this.setupFlow = { ...flow, ...limits, chainStrategies, step: "strategy-confirm", strategyText: combinedStrategy };
        this.addAgentMessage(
          `Review before live configuration:\n\n${combinedStrategy}\n\nMax SOL/trade: ${limits.maxTradeSol ?? "not specified"}\nMax USD/trade: ${limits.maxTradeUsd ?? "not specified"}\n\n${this.setupPromptFor("strategy-confirm")}`,
        );
        return;
      }

      if (flow.step === "strategy-confirm") {
        if (isNegative(text)) {
          this.setupFlow = {
            step: "strategy",
            ...(flow.developerWallet ? { developerWallet: flow.developerWallet } : {}),
            ...(flow.solanaRecoveryWallet ? { solanaRecoveryWallet: flow.solanaRecoveryWallet } : {}),
            ...(flow.selectedChains ? { selectedChains: flow.selectedChains } : {}),
            ...(flow.slippageBps !== undefined ? { slippageBps: flow.slippageBps } : {}),
            chainStrategies: {},
            currentStrategyChain: (flow.selectedChains ?? ["solana"])[0],
          };
          this.addAgentMessage(this.setupPromptFor("strategy"));
          return;
        }
        if (!isAffirmative(text)) {
          this.addAgentMessage(this.setupPromptFor("strategy-confirm"));
          return;
        }
        if (!flow.strategyText) {
          this.setupFlow = { ...flow, step: "strategy" };
          this.addAgentMessage(this.setupPromptFor("strategy"));
          return;
        }
        await this.callSetupAgent({
          ...buildStrategyUpdateArgs(flow.strategyText, false),
          chainStrategies: flow.chainStrategies,
          selectedChains: flow.selectedChains,
          solanaRecoveryWallet: flow.solanaRecoveryWallet,
          ...(flow.maxTradeSol !== undefined ? { maxTradeSol: flow.maxTradeSol } : {}),
          ...(flow.maxTradeUsd !== undefined ? { maxTradeUsd: flow.maxTradeUsd } : {}),
        });
        this.setupFlow = { ...flow, step: "subscriptions" };
        this.addAgentMessage(`Strategy configured for live execution.\n\n${this.setupPromptFor("subscriptions")}`);
        return;
      }

      if (flow.step === "subscriptions") {
        if (isAffirmative(text)) {
          const chains = flow.selectedChains ?? ["solana"];
          if (chains.includes("solana")) {
            await this.mcp.callTool("create_subscription", {
              type: "new_token_launch",
              chain: "solana",
              filter: { platform: "pumpfun" },
              format: "summary",
            });
            this.addSystemMessage("Tool: create_subscription");
          }
        } else if (!isNegative(text)) {
          this.addAgentMessage(this.setupPromptFor("subscriptions"));
          return;
        }
        this.setupFlow = null;
        this.addAgentMessage("Setup is complete. I am starting the agent loop and checking the portfolio now.");
        await this.tryStartLoop();
      }
    } catch (err: unknown) {
      this.addErrorMessage(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
      this.addAgentMessage(`${this.setupPromptFor(this.setupFlow?.step ?? flow.step)} Try again.`);
    }
  }

  private async callSetupAgent(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const resp = await this.mcp.callTool("setup_agent", args);
    const text = resp.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
    this.applyToolResult("setup_agent", text);
    this.addSystemMessage(`Tool: setup_agent ${String(args.action ?? "")}`.trim());
    const parsed = parseJsonObject(text);
    if (!parsed) throw new Error("setup_agent returned non-JSON response");
    const structured = asRecord(parsed.structured) ?? parsed;
    if (parsed.ok === false || structured.error) {
      throw new Error(String(structured.error ?? parsed.error ?? "setup_agent rejected the request"));
    }
    return {
      ...parsed,
      ...structured,
    };
  }

  private applyToolResult(name: string, resultText: string): void {
    const parsed = parseJsonObject(resultText);
    if (!parsed) return;

    if (name === "setup_agent") {
      const structured = asRecord(parsed.structured) ?? parsed;
      const wallets = collectWallets(structured);
      if (wallets.length > 0) {
        this.setters.setStatus((prev) => ({
          ...prev,
          wallets: mergeWallets(prev.wallets, wallets),
        }));
      }
      if (structured.action === "create_wallet") {
        const chain = normalizeChain(structured.chain);
        const address = typeof structured.address === "string" ? structured.address : undefined;
        if (chain && address) {
          this.upsertWallet({ chain, address });
        }
      }
      return;
    }

    if (name === "agent_portfolio") {
      this.applyPortfolioSnapshot(parsed);
    }
  }

  private applyPortfolioSnapshot(parsed: Record<string, unknown>): void {
    const structured = asRecord(parsed.structured);
    const snapshot = asRecord(structured?.snapshot) ?? asRecord(parsed.snapshot) ?? asRecord(parsed.portfolio) ?? parsed;
    const data = asRecord(snapshot.data);
    const wallets = mergeWallets(collectWallets(snapshot), data ? collectWallets(data) : []);
    const summed = data ? sumWalletBalances(data) : sumWalletBalances(snapshot);
    const balanceSol = firstNumber(snapshot, ["totalValueSol", "portfolioValueSol", "portfolio_value_sol", "total_value_sol"])
      ?? (data ? firstNumber(data, ["totalValueSol", "portfolioValueSol", "portfolio_value_sol", "total_value_sol"]) : undefined)
      ?? summed.balanceSol;
    const balanceUsd = firstNumber(snapshot, ["totalValueUsd", "portfolioValueUsd", "portfolio_value_usd", "total_value_usd", "valueUsd"])
      ?? (data ? firstNumber(data, ["totalValueUsd", "portfolioValueUsd", "portfolio_value_usd", "total_value_usd", "valueUsd"]) : undefined)
      ?? summed.balanceUsd;
    const positions = collectPositions(data ?? snapshot);

    this.setters.setStatus((prev) => ({
      ...prev,
      ...(balanceSol !== undefined ? { balanceSol } : {}),
      ...(balanceUsd !== undefined ? { balanceUsd } : {}),
      ...(wallets.length > 0 ? { wallets: mergeWallets(prev.wallets, wallets) } : {}),
      ...(positions ? { activeTrades: positions } : {}),
    }));
  }

  private upsertWallet(wallet: WalletInfo): void {
    this.setters.setStatus((prev) => {
      const wallets = prev.wallets.filter((existing) => existing.chain !== wallet.chain);
      return { ...prev, wallets: [...wallets, wallet] };
    });
  }

  private async ensureDefaultSubscriptions(): Promise<void> {
    if (!this.config.autoSeedSubscriptions) {
      return;
    }

    try {
      const resp = await this.mcp.callTool('list_subscriptions', {});
      const text = resp.content?.find((c: { type: string; text?: string }) => c.type === 'text')?.text ?? '{}';
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch (_error: unknown) {
        parsed = {};
      }

      const structured = parsed.structured as Record<string, unknown> | undefined;
      const subscriptions = structured?.subscriptions;
      if (Array.isArray(subscriptions) && subscriptions.length > 0) {
        return;
      }

      const created = await this.mcp.callTool('create_subscription', {
        type: 'new_token_launch',
        chain: 'solana',
        filter: { platform: 'pumpfun' },
        format: 'summary',
      });

      if (!this.isToolError(created)) {
        this.addSystemMessage('Default subscription enabled: Solana new token launches (Pump.fun).');
        this.config.autoSeedSubscriptions = false;
      } else {
        this.addSystemMessage('Default subscription was not enabled automatically. Configure subscriptions manually if you want event-driven trading.');
      }
    } catch (_error: unknown) {
      this.addSystemMessage('Default subscription setup was skipped. Configure subscriptions manually if you want autonomous event monitoring.');
    }
  }

  /** Check if setup is complete. Returns true if ready to trade, false if needs setup. */
  private async fetchSetupStatus(): Promise<SetupStatusSnapshot | null> {
    try {
      const resp = await this.mcp.callTool("setup_agent", { action: "get_status" });
      const text = resp.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch (_error: unknown) { parsed = {}; }
      const structured = parsed.structured as Record<string, unknown> | undefined;
      return parseSetupStatusSnapshot(structured);
    } catch (_error: unknown) {
      return null;
    }
  }

  private isSetupComplete(status: SetupStatusSnapshot | null): boolean {
    return isSetupReady(status);
  }

  /** Silent balance refresh — updates status panel only, no chat messages. */
  async refreshBalance(): Promise<void> {
    try {
      const response = await this.mcp.agentPortfolio();
      const text = response.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
      const parsed = parseJsonObject(text);
      if (parsed) this.applyPortfolioSnapshot(parsed);
    } catch (_error: unknown) {
      // Silent — don't spam chat
    }
  }

  async checkBalance(): Promise<void> {
    try {
      const response = await this.mcp.agentPortfolio();
      const text = response.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
      const parsed = parseJsonObject(text);
      const snapshot = parsed
        ? asRecord(asRecord(parsed.structured)?.snapshot) ?? asRecord(parsed.snapshot) ?? asRecord(parsed.portfolio) ?? parsed
        : {};
      const data = asRecord(snapshot.data);
      const sol = firstNumber(snapshot, ["totalValueSol", "portfolioValueSol", "portfolio_value_sol", "total_value_sol"])
        ?? (data ? firstNumber(data, ["totalValueSol", "portfolioValueSol", "portfolio_value_sol", "total_value_sol"]) : undefined)
        ?? (data ? sumWalletBalances(data).balanceSol : sumWalletBalances(snapshot).balanceSol)
        ?? 0;
      if (parsed) this.applyPortfolioSnapshot(parsed);
      if (sol < 0.01 && !this.lowBalanceWarned) {
        this.lowBalanceWarned = true;
        this.addErrorMessage(`Wallet balance looks low (${sol} SOL). Fund the selected trading wallet before live execution.`);
      }
      if (sol >= 0.01) {
        this.lowBalanceWarned = false;
      }
    } catch (_error: unknown) {
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
      try { parsed = JSON.parse(text) as Record<string, unknown>; } catch (_error: unknown) { parsed = {}; }
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
    } catch (_error: unknown) {
      // Fallback: try setup_agent get_status for boolean flags
      try {
        const resp = await this.mcp.callTool("setup_agent", { action: "get_status" });
        const text = resp.content?.find((c: { type: string; text?: string }) => c.type === "text")?.text ?? "{}";
        let parsed: Record<string, unknown>;
        try { parsed = JSON.parse(text) as Record<string, unknown>; } catch (_innerError: unknown) { parsed = {}; }
        const structured = parsed.structured as Record<string, unknown> | undefined;
        if (structured?.slippageConfigured) result.slippageBps = result.slippageBps ?? undefined;
        if (structured?.strategyConfigured) result.strategy = result.strategy ?? "configured";
      } catch (_innerError: unknown) {
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
    } catch (_error: unknown) {
      return false;
    }
  }

  /** Update strategy on the server via MCP. Returns false if backend rejected. */
  async updateStrategy(rules: string): Promise<boolean> {
    try {
      const resp = await this.mcp.callTool("setup_agent", {
        ...buildStrategyUpdateArgs(rules, this.config.shadowMode),
      });
      return !this.isToolError(resp);
    } catch (_error: unknown) {
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
    } catch (_error: unknown) { /* not JSON */ }
    return false;
  }

  /** Get current local config for settings display. Reads from disk to catch recent saves. */
  getLocalConfig(): { provider: string; model: string; maxDailyCost: number } {
    const saved = loadAgent();
    if (saved) {
      return {
        provider: resolveProviderLabel(saved.llmProvider ?? this.config.llmProvider, saved.llmBaseUrl ?? this.config.llmBaseUrl),
        model: saved.llmModel ?? this.config.llmModel ?? "(default)",
        maxDailyCost: saved.maxDailyLlmCost ?? this.config.maxDailyLlmCost ?? 5,
      };
    }
    return {
      provider: resolveProviderLabel(this.config.llmProvider, this.config.llmBaseUrl),
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
