export type SetupChain = "solana" | "base";

export interface SetupStatusSnapshot {
  developerWalletBound?: boolean;
  rootWalletKind?: "evm" | "solana";
  rootWalletKinds?: Array<"evm" | "solana">;
  evmWalletBound?: boolean;
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
  const rootWalletKinds = Array.isArray(structured?.rootWalletKinds)
    ? structured.rootWalletKinds.filter((kind): kind is "evm" | "solana" => kind === "evm" || kind === "solana")
    : [];
  const rootWalletKind = structured?.rootWalletKind === "evm" || structured?.rootWalletKind === "solana"
    ? structured.rootWalletKind
    : undefined;
  return {
    developerWalletBound:
      structured?.developerWalletBound === true
      || structured?.walletBound === true
      || structured?.rootWalletBound === true,
    rootWalletKind,
    rootWalletKinds,
    evmWalletBound: structured?.evmWalletBound === true || rootWalletKind === "evm" || rootWalletKinds.includes("evm"),
    walletsConfigured: structured?.walletsConfigured === true,
    tradingConfigured: structured?.tradingConfigured === true,
    slippageConfigured: structured?.slippageConfigured === true,
    strategyConfigured: structured?.strategyConfigured === true,
    solanaWalletBound: structured?.solanaWalletBound === true || rootWalletKind === "solana" || rootWalletKinds.includes("solana"),
    selectedChains: normalizeSelectedChains(structured?.selectedChains),
    nextStep: typeof structured?.nextStep === "string" ? structured.nextStep : null,
  };
}

export function getInitialSetupStep(status: SetupStatusSnapshot): "developer-wallet" | "networks" | "solana-recovery-wallet" | "slippage" | "strategy" | "subscriptions" {
  const selectedChains = status.selectedChains ?? [];
  if (!status.developerWalletBound && selectedChains.length === 0) return "networks";
  if (selectedChains.includes("base") && !status.evmWalletBound) return "developer-wallet";
  if (selectedChains.includes("solana") && !status.solanaWalletBound) return "solana-recovery-wallet";
  if (!status.walletsConfigured) return "networks";
  if (!status.slippageConfigured) return "slippage";
  if (!status.strategyConfigured && !status.tradingConfigured) return "strategy";
  return "subscriptions";
}

export function isSetupReady(status: SetupStatusSnapshot | null): boolean {
  if (!status) return false;
  if (status.nextStep) return false;
  if (status.selectedChains?.includes("base") && !status.evmWalletBound) return false;
  if (status.selectedChains?.includes("solana") && !status.solanaWalletBound) return false;
  return status.tradingConfigured === true && status.walletsConfigured === true;
}

export function buildSetupRequiredMessage(status: SetupStatusSnapshot): string {
  const selectedChains = status.selectedChains ?? [];
  if (!status.developerWalletBound && selectedChains.length === 0) {
    return "Setup incomplete. I will guide you here in chat. First: choose the trading networks: Solana, Base (EVM), or both.";
  }

  if (selectedChains.includes("base") && !status.evmWalletBound) {
    return "Setup incomplete. Base trading requires your Base/EVM 0x developer wallet for recovery and Hub access.";
  }

  if (selectedChains.includes("solana") && !status.solanaWalletBound) {
    return "Setup incomplete. Solana trading requires your Solana root/recovery/withdrawal wallet. This same address is used for Solana withdrawals.";
  }

  if (!status.walletsConfigured) {
    return "Setup incomplete. Next: choose the trading networks: Solana, Base (EVM), or both. I will create the selected trading wallets.";
  }

  if (!status.slippageConfigured) {
    return "Setup incomplete. Next: configure slippage. You can answer in percent or bps, for example 3% = 300 bps.";
  }

  if (!status.strategyConfigured && !status.tradingConfigured) {
    return "Setup incomplete. Next: define hard limits and describe your trading strategy. Execution remains approval-gated.";
  }

  return "Setup incomplete. Continue the remaining setup steps in chat before approved trading can start.";
}
