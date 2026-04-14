// src/tui/types.ts

export type MessageType = "agent" | "user" | "system" | "trade" | "error";

export interface ChatMessage {
  id: string;
  type: MessageType;
  text: string;
  timestamp: number;
  /** For trade messages: token address */
  token?: string;
  /** For trade messages: buy/sell */
  action?: "buy" | "sell";
  /** For trade messages: SOL amount */
  amount?: string;
}

export interface TradeInfo {
  token: string;
  action: "buy" | "sell";
  amount: string;
  entryPrice?: number;
  currentPricePct?: number;
  txSignature?: string;
  timestamp: number;
}

export interface WalletInfo {
  chain: "solana" | "base";
  address: string;
}

export interface ToolCall {
  name: string;
  durationMs: number;
  success: boolean;
  timestamp: number;
}

export interface StatusData {
  balanceSol: number;
  balanceUsd: number;
  wallets: WalletInfo[];
  activeTrades: TradeInfo[];
  recentTools: ToolCall[];
  eventsReceived: number;
  decisionsExecuted: number;
  tradesExecuted: number;
  llmCostToday: number;
  maxDailyLlmCost: number;
  uptime: number;
  sseConnected: boolean;
  status: string;
  provider?: string;
  model?: string;
}

export interface TuiConfig {
  mcpEndpoint: string;
  apiKey: string;
  llmProvider: "anthropic" | "openai";
  llmApiKey: string;
  llmModel?: string;
  llmBaseUrl?: string;
  maxDailyLlmCost?: number;
  llmTimeoutMs?: number;
  publicId: string;
  strategy: string;
  shadowMode: boolean;
}
