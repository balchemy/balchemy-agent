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
    return "Setup incomplete. Next: bind your developer wallet, then create your trading wallets.";
  }

  if (!status.walletsConfigured) {
    return "Setup incomplete. Next: create your trading wallets and fund your Solana wallet before live trading.";
  }

  if (!status.slippageConfigured) {
    return "Setup incomplete. Next: configure your slippage tolerance.";
  }

  if (!status.strategyConfigured && !status.tradingConfigured) {
    return "Setup incomplete. Next: describe your trading strategy so live execution can be configured.";
  }

  return "Setup incomplete. Continue the remaining setup steps in chat before live trading starts.";
}
