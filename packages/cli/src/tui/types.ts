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
  /** For trade messages: amount in the displayed unit */
  amount?: string;
  amountUnit?: string;
}
