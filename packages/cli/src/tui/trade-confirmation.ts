import type { TradeConfirmationDetails } from "./types.js";

const UNKNOWNISH_VALUES = new Set([
  "",
  "?",
  "unknown",
  "undefined",
  "null",
  "none",
  "n/a",
  "na",
  "random",
  "rastgele",
  "herhangi",
  "any",
]);

const SOLANA_ADDRESS_PATTERN = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;
const EVM_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/;

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function isUnknownish(value: string): boolean {
  return UNKNOWNISH_VALUES.has(value.trim().toLowerCase());
}

function inferAction(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (/\b(buy|purchase|long|al|alı?m|satin al|satın al)\b/i.test(normalized)) return "buy";
  if (/\b(sell|short|sat|satı?ş)\b/i.test(normalized)) return "sell";
  if (/\b(swap|takas)\b/i.test(normalized)) return "swap";
  return undefined;
}

function normalizeAction(value: string | undefined, intent: string): string {
  const raw = value ?? inferAction(intent) ?? "trade";
  const normalized = raw.trim().toLowerCase();
  if (/\b(buy|purchase|long|al|alı?m|satin al|satın al)\b/i.test(normalized)) return "buy";
  if (/\b(sell|short|sat|satı?ş)\b/i.test(normalized)) return "sell";
  if (/\b(swap|takas)\b/i.test(normalized)) return "swap";
  return "trade";
}

function inferChain(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (/\b(solana|sol)\b/i.test(normalized)) return "solana";
  if (/\b(base|evm|ethereum|eth)\b/i.test(normalized)) return "base";
  return undefined;
}

function normalizeChain(value: string | undefined, intent: string): string {
  const raw = value ?? inferChain(intent) ?? "unknown";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "sol" || normalized === "solana") return "solana";
  if (normalized === "base" || normalized === "evm" || normalized === "ethereum") return "base";
  return "unknown";
}

function normalizeAmount(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(",", ".");
  const match = normalized.match(/\d+(?:\.\d+)?/);
  if (!match) return undefined;
  const amount = Number(match[0]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  return match[0];
}

function inferAmount(text: string): string | undefined {
  const match = text.replace(",", ".").match(/\b(\d+(?:\.\d+)?)\s*(?:sol|usd|usdc|eth)\b/i);
  if (!match?.[1]) return undefined;
  return normalizeAmount(match[1]);
}

function inferToken(text: string): string | undefined {
  const evm = text.match(EVM_ADDRESS_PATTERN)?.[0];
  if (evm) return evm;
  return text.match(SOLANA_ADDRESS_PATTERN)?.[0];
}

function shortTokenForPhrase(token: string): string {
  if (token.length <= 18) return token;
  return `${token.slice(0, 8)}...${token.slice(-6)}`;
}

function validateTrade(details: Omit<TradeConfirmationDetails, "approvalPhrase" | "canApprove" | "blockReason" | "rawArgs">): {
  canApprove: boolean;
  blockReason?: string;
} {
  const missing: string[] = [];
  const action = details.action.trim().toLowerCase();
  const chain = details.chain.trim().toLowerCase();
  const token = details.token.trim();
  const amount = normalizeAmount(details.amount);
  const intent = details.intent.toLowerCase();

  if (!["buy", "sell", "swap"].includes(action)) missing.push("action");
  if (chain !== "solana" && chain !== "base") missing.push("chain");
  if (isUnknownish(token) || /\b(random|rastgele|herhangi)\b/i.test(token)) missing.push("token");
  if (!amount) missing.push("amount");

  if (/\b(random|rastgele|herhangi)\b/i.test(intent) && (isUnknownish(token) || missing.includes("token"))) {
    return {
      canApprove: false,
      blockReason: "Random or unknown token requests cannot be approved. Select an exact token/mint/contract after read-only discovery and risk checks.",
    };
  }

  if (missing.length > 0) {
    return {
      canApprove: false,
      blockReason: `Trade preview is incomplete: missing ${missing.join(", ")}. No MCP trade call was sent.`,
    };
  }

  return { canApprove: true };
}

export function buildTradeConfirmationDetails(args: Record<string, unknown>): TradeConfirmationDetails {
  const intent = firstString(args.intent, args.message, args.command, args.prompt) ?? "trade";
  const action = normalizeAction(firstString(args.action, args.side, args.orderSide), intent);
  const token = firstString(
    args.token,
    args.tokenMint,
    args.tokenAddress,
    args.mint,
    args.contract,
    args.contractAddress,
    args.address,
    args.outputToken,
  ) ?? inferToken(intent) ?? "unknown";
  const amount = normalizeAmount(firstString(args.amount, args.size, args.solAmount, args.usdAmount, args.quantity))
    ?? inferAmount(intent)
    ?? "?";
  const chain = normalizeChain(firstString(args.chain, args.network), intent);
  const unit = chain === "base" ? "USD/USDC" : "SOL";
  const preview = `${action.toUpperCase()} ${amount} ${unit} -> ${shortTokenForPhrase(token)}`;
  const validation = validateTrade({ preview, intent, action, token, amount, chain });
  const approvalPhrase = validation.canApprove
    ? `TRADE ${action.toUpperCase()} ${chain.toUpperCase()} ${amount} ${shortTokenForPhrase(token)}`
    : "BLOCKED";

  return {
    preview,
    intent,
    action,
    token,
    amount,
    chain,
    approvalPhrase,
    canApprove: validation.canApprove,
    blockReason: validation.blockReason,
    rawArgs: args,
  };
}
