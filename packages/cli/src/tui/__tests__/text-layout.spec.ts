import test from "node:test";
import assert from "node:assert/strict";
import {
  displayWidth,
  truncateEnd,
  truncateMiddle,
  wrapText,
} from "../text-layout.js";

const LONG_SOLANA_ADDRESS = "Gn3SVaU82oGS1yb28HqNw3fYQR6MsvECofaacbd9Xq8S";
const LONG_BASE_ADDRESS = "0x1111111111111111111111111111111111111111";
const LONG_TOOL_PAYLOAD = `Tool: setup_agent ${JSON.stringify({
  action: "configure_autonomous",
  naturalLanguageRules: "Maksimum işlem boyutu $10, sadece Base ve Solana test profilleri, uzun açıklama taşmamalı.",
  wallet: LONG_SOLANA_ADDRESS,
})}`;

test("wrapText keeps every line inside terminal column budgets", () => {
  for (const width of [80, 100, 120, 160]) {
    const lines = wrapText(
      `${LONG_TOOL_PAYLOAD}\nBase wallet ${LONG_BASE_ADDRESS}\nTürkçe metinler kutudan taşmamalı.`,
      width,
    );

    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.ok(
        displayWidth(line) <= width,
        `line width ${displayWidth(line)} exceeded ${width}: ${line}`,
      );
    }
  }
});

test("wrapText breaks long single tokens without exceeding narrow budgets", () => {
  for (const width of [8, 12, 18, 24]) {
    const lines = wrapText(`${LONG_SOLANA_ADDRESS}${LONG_BASE_ADDRESS}`, width);
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(
        displayWidth(line) <= width,
        `line width ${displayWidth(line)} exceeded ${width}: ${line}`,
      );
    }
  }
});

test("truncate helpers respect unicode display width", () => {
  const text = `İstanbul stratejisi ${LONG_SOLANA_ADDRESS}`;

  for (const width of [18, 28, 38]) {
    assert.ok(displayWidth(truncateEnd(text, width)) <= width);
    assert.ok(displayWidth(truncateMiddle(text, width)) <= width);
  }
});
