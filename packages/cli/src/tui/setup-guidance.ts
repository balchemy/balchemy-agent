export type SetupChain = "solana" | "base";

export interface SetupStatusSnapshot {
  developerWalletBound?: boolean;
  walletsConfigured?: boolean;
  tradingConfigured?: boolean;
  slippageConfigured?: boolean;
  strategyConfigured?: boolean;
  solanaWalletBound?: boolean;
  selectedChains?: SetupChain[];
  nextStep?: string | null;
}

function normalizeSelectedChains(value: unknown): SetupChain[] {
  if (!Array.isArray(value)) return [];
  const chains: SetupChain[] = [];
  for (const item of value) {
    if (item === "solana" || item === "solana-devnet") chains.push("solana");
    if (item === "base" || item === "base-sepolia") chains.push("base");
  }
  return [...new Set(chains)];
}

export function parseNetworkSelection(value: string): SetupChain[] | null {
  const normalized = value.trim().toLowerCase();
  const wantsBoth = /\b(both|ikisi|hepsi|all)\b/.test(normalized) || (normalized.includes("solana") && normalized.includes("base"));
  if (wantsBoth) return ["solana", "base"];
  const chains: SetupChain[] = [];
  if (/\b(sol|solana|devnet)\b/.test(normalized)) chains.push("solana");
  if (/\b(base|evm|sepolia|0x)\b/.test(normalized)) chains.push("base");
  return chains.length > 0 ? chains : null;
}

export function parseSetupStatusSnapshot(
  structured?: Record<string, unknown>,
): SetupStatusSnapshot {
  return {
    developerWalletBound:
      structured?.developerWalletBound === true
      || structured?.walletBound === true,
    walletsConfigured: structured?.walletsConfigured === true,
    tradingConfigured: structured?.tradingConfigured === true,
    slippageConfigured: structured?.slippageConfigured === true,
    strategyConfigured: structured?.strategyConfigured === true,
    solanaWalletBound: structured?.solanaWalletBound === true,
    selectedChains: normalizeSelectedChains(structured?.selectedChains),
    nextStep: typeof structured?.nextStep === "string" ? structured.nextStep : null,
  };
}

export function getInitialSetupStep(status: SetupStatusSnapshot): "developer-wallet" | "networks" | "solana-recovery-wallet" | "slippage" | "strategy" | "subscriptions" {
  if (!status.developerWalletBound) return "developer-wallet";
  if (!status.walletsConfigured) return "networks";
  if (status.selectedChains?.includes("solana") && !status.solanaWalletBound) return "solana-recovery-wallet";
  if (!status.slippageConfigured) return "slippage";
  if (!status.strategyConfigured && !status.tradingConfigured) return "strategy";
  return "subscriptions";
}

export function isSetupReady(status: SetupStatusSnapshot | null): boolean {
  if (!status) return false;
  if (status.nextStep) return false;
  if (status.selectedChains?.includes("solana") && !status.solanaWalletBound) return false;
  return status.tradingConfigured === true && status.walletsConfigured === true;
}

export function buildSetupRequiredMessage(status: SetupStatusSnapshot): string {
  if (!status.developerWalletBound) {
    return "Setup incomplete. I will guide you here in chat. First: provide your Base/EVM 0x developer wallet for recovery and Hub access.";
  }

  if (!status.walletsConfigured) {
    return "Setup incomplete. Next: choose the trading networks: Solana, Base (EVM), or both. I will create the selected trading wallets.";
  }

  if (status.selectedChains?.includes("solana") && !status.solanaWalletBound) {
    return "Setup incomplete. Solana trading was selected. Next: provide your Solana recovery/withdrawal wallet.";
  }

  if (!status.slippageConfigured) {
    return "Setup incomplete. Next: configure slippage. You can answer in percent or bps, for example 3% = 300 bps.";
  }

  if (!status.strategyConfigured && !status.tradingConfigured) {
    return "Setup incomplete. Next: define hard limits and describe your trading strategy so live execution can be configured.";
  }

  return "Setup incomplete. Continue the remaining setup steps in chat before live trading starts.";
}
