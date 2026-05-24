import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupRequiredMessage,
  getInitialSetupStep,
  isSetupReady,
  parseNetworkSelection,
  parseSetupStatusSnapshot,
} from "../setup-guidance.js";

test("buildSetupRequiredMessage points to network selection first", () => {
  assert.match(
    buildSetupRequiredMessage({
      developerWalletBound: false,
      walletsConfigured: false,
    }),
    /choose the trading networks/i,
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

test("buildSetupRequiredMessage prioritizes network selection when no chains exist", () => {
  assert.match(
    buildSetupRequiredMessage({
      developerWalletBound: false,
      walletsConfigured: true,
      tradingConfigured: false,
    }),
    /choose the trading networks/i,
  );
});

test("base setup asks for EVM root wallet after network selection", () => {
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: false,
      walletsConfigured: false,
      selectedChains: ["base"],
      solanaWalletBound: false,
    }),
    "developer-wallet",
  );
  assert.match(
    buildSetupRequiredMessage({
      developerWalletBound: false,
      walletsConfigured: false,
      selectedChains: ["base"],
      solanaWalletBound: false,
    }),
    /Base trading requires/i,
  );
});

test("solana-only setup asks for Solana root wallet after network selection", () => {
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: false,
      walletsConfigured: false,
      selectedChains: ["solana"],
      solanaWalletBound: false,
    }),
    "solana-recovery-wallet",
  );
  assert.match(
    buildSetupRequiredMessage({
      developerWalletBound: false,
      walletsConfigured: false,
      selectedChains: ["solana"],
      solanaWalletBound: false,
    }),
    /Solana trading requires/i,
  );
});

test("base-only setup moves from networks directly to slippage", () => {
  assert.deepEqual(parseNetworkSelection("base"), ["base"]);
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      evmWalletBound: true,
      walletsConfigured: true,
      selectedChains: ["base"],
      solanaWalletBound: false,
      slippageConfigured: false,
    }),
    "slippage",
  );
});

test("solana setup with EVM root requires a Solana root wallet before slippage", () => {
  assert.deepEqual(parseNetworkSelection("solana"), ["solana"]);
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      evmWalletBound: true,
      walletsConfigured: true,
      selectedChains: ["solana"],
      solanaWalletBound: false,
      slippageConfigured: false,
    }),
    "solana-recovery-wallet",
  );
});

test("both networks require Solana root wallet when EVM root already exists", () => {
  assert.deepEqual(parseNetworkSelection("both"), ["solana", "base"]);
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      evmWalletBound: true,
      walletsConfigured: true,
      selectedChains: ["solana", "base"],
      solanaWalletBound: false,
      slippageConfigured: false,
    }),
    "solana-recovery-wallet",
  );
});

test("solana-root agent adding base asks for EVM wallet", () => {
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      rootWalletKind: "solana",
      rootWalletKinds: ["solana"],
      evmWalletBound: false,
      walletsConfigured: true,
      selectedChains: ["solana", "base"],
      solanaWalletBound: true,
      slippageConfigured: false,
    }),
    "developer-wallet",
  );
});

test("base-root agent adding solana asks for Solana root wallet", () => {
  assert.equal(
    getInitialSetupStep({
      developerWalletBound: true,
      rootWalletKind: "evm",
      rootWalletKinds: ["evm"],
      evmWalletBound: true,
      walletsConfigured: true,
      selectedChains: ["base", "solana"],
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
