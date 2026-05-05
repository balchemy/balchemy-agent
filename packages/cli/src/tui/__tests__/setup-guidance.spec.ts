import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupRequiredMessage,
  getInitialSetupStep,
  isSetupReady,
  parseNetworkSelection,
  parseSetupStatusSnapshot,
} from "../setup-guidance.js";

test("buildSetupRequiredMessage points to wallet binding first", () => {
  assert.match(
    buildSetupRequiredMessage({
      developerWalletBound: false,
      walletsConfigured: false,
    }),
    /developer wallet/i,
  );
});

test("buildSetupRequiredMessage points to strategy setup when wallets exist", () => {
  assert.match(
    buildSetupRequiredMessage({
      developerWalletBound: true,
      walletsConfigured: true,
      slippageConfigured: true,
      strategyConfigured: false,
      tradingConfigured: false,
    }),
    /trading strategy/i,
  );
});

test("parseSetupStatusSnapshot accepts walletBound as legacy setup field", () => {
  const snapshot = parseSetupStatusSnapshot({
    walletBound: true,
    walletsConfigured: false,
    tradingConfigured: false,
  });

  assert.equal(snapshot.developerWalletBound, true);
  assert.equal(snapshot.walletsConfigured, false);
  assert.equal(snapshot.tradingConfigured, false);
});

test("buildSetupRequiredMessage still prioritizes wallet binding when wallets already exist", () => {
  assert.match(
    buildSetupRequiredMessage({
      developerWalletBound: false,
      walletsConfigured: true,
      tradingConfigured: false,
    }),
    /developer wallet/i,
  );
});

test("base-only setup moves from networks directly to slippage", () => {
  assert.deepEqual(parseNetworkSelection("base"), ["base"]);
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      walletsConfigured: true,
      selectedChains: ["base"],
      solanaWalletBound: false,
      slippageConfigured: false,
    }),
    "slippage",
  );
});

test("solana setup requires a Solana recovery wallet after wallet creation", () => {
  assert.deepEqual(parseNetworkSelection("solana"), ["solana"]);
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      walletsConfigured: true,
      selectedChains: ["solana"],
      solanaWalletBound: false,
      slippageConfigured: false,
    }),
    "solana-recovery-wallet",
  );
});

test("both networks create both chains and require Solana recovery", () => {
  assert.deepEqual(parseNetworkSelection("both"), ["solana", "base"]);
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      walletsConfigured: true,
      selectedChains: ["solana", "base"],
      solanaWalletBound: false,
      slippageConfigured: false,
    }),
    "solana-recovery-wallet",
  );
});

test("setup is not ready when backend reports a remaining nextStep", () => {
  const snapshot = parseSetupStatusSnapshot({
    walletsConfigured: true,
    tradingConfigured: true,
    selectedChains: ["solana"],
    solanaWalletBound: false,
    nextStep: "bind_solana_developer_wallet",
  });

  assert.equal(isSetupReady(snapshot), false);
});
