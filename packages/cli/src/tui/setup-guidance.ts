export interface SetupStatusSnapshot {
  developerWalletBound?: boolean;
  walletsConfigured?: boolean;
  tradingConfigured?: boolean;
  slippageConfigured?: boolean;
  strategyConfigured?: boolean;
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
  };
}

export function buildSetupRequiredMessage(status: SetupStatusSnapshot): string {
  if (!status.developerWalletBound) {
    return "Setup incomplete. I will guide you here in chat. First: provide your Base/EVM 0x developer wallet for recovery and Hub access.";
  }

  if (!status.walletsConfigured) {
    return "Setup incomplete. Next: choose the trading networks: Solana, Base (EVM), or both. I will create the selected trading wallets.";
  }

  if (!status.slippageConfigured) {
    return "Setup incomplete. Next: configure slippage. You can answer in percent or bps, for example 3% = 300 bps.";
  }

  if (!status.strategyConfigured && !status.tradingConfigured) {
    return "Setup incomplete. Next: define hard limits and describe your strategy so live execution can be configured.";
  }

  return "Setup incomplete. Continue the remaining setup steps in chat before live trading starts.";
}
