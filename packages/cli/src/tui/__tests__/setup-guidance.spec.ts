import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSetupRequiredMessage,
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
