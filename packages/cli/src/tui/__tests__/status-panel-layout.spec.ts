import test from "node:test";
import assert from "node:assert/strict";
import { displayWidth } from "../text-layout.js";
import { formatWalletRow } from "../StatusPanel.js";
import type { WalletInfo } from "../types.js";

const wallets: WalletInfo[] = [
  {
    chain: "solana",
    address: "Gn3SVaU82oGS1yb28HqNw3fYQR6MsvECofaacbd9Xq8S",
  },
  {
    chain: "base",
    address: "0x1111111111111111111111111111111111111111",
  },
];

test("wallet rows fit narrow and standard status panel widths", () => {
  for (const panelWidth of [18, 22, 28, 30, 34]) {
    const contentWidth = panelWidth - 4;
    for (const wallet of wallets) {
      const row = formatWalletRow(wallet, contentWidth);
      assert.ok(
        displayWidth(row) <= contentWidth,
        `${row} exceeded content width ${contentWidth}`,
      );
      assert.match(row, /\.\.\./);
    }
  }
});
