import test from "node:test";
import assert from "node:assert/strict";
import {
  displayWidth,
  truncateEnd,
  truncateMiddle,
  wrapText,
} from "../text-layout.js";
import {
  isSetupBlockedSideEffectMessage,
  isSetupBypassReadOnlyMessage,
} from "../AgentBridge.js";
import {
  applyPromptEditorInput,
  buildTranscriptRows,
  formatTranscriptPlainText,
  getPromptViewport,
  getTranscriptViewport,
  isTerminalControlInput,
} from "../ChatPanel.js";
import type { TranscriptRow } from "../ChatPanel.js";

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

test("transcript rows preserve long primary chat text without activity trim marker", () => {
  const longMessage = Array.from({ length: 40 }, (_, index) => `satır-${index}`).join(" ");
  const rows = buildTranscriptRows(
    [
      {
        id: "msg-1",
        type: "agent",
        text: longMessage,
        timestamp: Date.parse("2026-02-11T00:00:00.000Z"),
      },
    ],
    24,
  );

  const bodyRows = rows.filter((row): row is Extract<TranscriptRow, { kind: "body" }> => row.kind === "body");
  const bodyText = bodyRows.map((row) => row.text).join(" ");

  assert.ok(rows.length > 8);
  assert.ok(!bodyText.includes("trimmed in activity log"));
  assert.ok(bodyText.includes("satır-0"));
  assert.ok(bodyText.includes("satır-39"));
});

test("terminal control input detection filters paging escape fragments", () => {
  for (const input of ["[5~", "[6~", "[5~", "[6~", "[5", "[6", "5~", "6~", "OA"]) {
    assert.equal(isTerminalControlInput(input), true);
  }

  for (const input of ["buy SOL", "what can you do?", ">"]) {
    assert.equal(isTerminalControlInput(input), false);
  }
});

test("prompt viewport keeps cursor visible for long input", () => {
  const value = "Solana yeni pair adaylarını tara ama trade yapma";
  const cursor = value.length;
  const viewport = getPromptViewport(value, cursor, 16);

  assert.ok(displayWidth(viewport.text) <= 16);
  assert.equal(viewport.cursorIndex, Array.from(viewport.text).length);
  assert.ok(viewport.text.includes("yapma"));
});

test("prompt editor handles backspace, delete and cursor movement before filtering control bytes", () => {
  assert.deepEqual(
    applyPromptEditorInput({ value: "abc", cursorIndex: 3 }, "\u007f", {}),
    { value: "ab", cursorIndex: 2 },
  );
  assert.deepEqual(
    applyPromptEditorInput({ value: "abc", cursorIndex: 1 }, "\u001b[3~", {}),
    { value: "ac", cursorIndex: 1 },
  );
  assert.deepEqual(
    applyPromptEditorInput({ value: "abc", cursorIndex: 2 }, "", { leftArrow: true }),
    { value: "abc", cursorIndex: 1 },
  );
  assert.deepEqual(
    applyPromptEditorInput({ value: "abc", cursorIndex: 1 }, "", { rightArrow: true }),
    { value: "abc", cursorIndex: 2 },
  );
  assert.deepEqual(
    applyPromptEditorInput({ value: "abc", cursorIndex: 2 }, "Z", {}),
    { value: "abZc", cursorIndex: 3 },
  );
});

test("prompt editor supports ctrl-a and ctrl-e navigation", () => {
  assert.deepEqual(
    applyPromptEditorInput({ value: "abcdef", cursorIndex: 3 }, "a", { ctrl: true }),
    { value: "abcdef", cursorIndex: 0 },
  );
  assert.deepEqual(
    applyPromptEditorInput({ value: "abcdef", cursorIndex: 3 }, "e", { ctrl: true }),
    { value: "abcdef", cursorIndex: 6 },
  );
});

test("plain transcript export preserves content without panel borders", () => {
  const transcript = formatTranscriptPlainText([
    {
      id: "msg-1",
      type: "user",
      text: "Runtime durumumu göster.",
      timestamp: Date.parse("2026-02-11T00:00:00.000Z"),
    },
    {
      id: "msg-2",
      type: "system",
      text: "Tool: agent_status",
      timestamp: Date.parse("2026-02-11T00:01:00.000Z"),
    },
    {
      id: "msg-3",
      type: "agent",
      text: "Mode: shadow\nArmed: false",
      timestamp: Date.parse("2026-02-11T00:02:00.000Z"),
    },
  ]);

  assert.match(transcript, /YOU/);
  assert.match(transcript, /TOOL/);
  assert.match(transcript, /agent_status/);
  assert.match(transcript, /Mode: shadow/);
  assert.equal(transcript.includes("╭"), false);
  assert.equal(transcript.includes("│"), false);
});

test("transcript viewport scrolls by rendered rows", () => {
  const rows = buildTranscriptRows(
    [
      {
        id: "msg-1",
        type: "agent",
        text: Array.from({ length: 20 }, (_, index) => `token-${index}`).join(" "),
        timestamp: Date.parse("2026-02-11T00:00:00.000Z"),
      },
    ],
    18,
  );

  const bottom = getTranscriptViewport(rows, 4, 0);
  const older = getTranscriptViewport(rows, 4, 3);

  assert.equal(bottom.visibleRows.length, 4);
  assert.equal(older.visibleRows.length, 4);
  assert.ok(older.end < bottom.end);
  assert.ok(older.scrollOffset > 0);
});

test("read-only runtime prompts bypass setup wizard input handling", () => {
  assert.equal(
    isSetupBypassReadOnlyMessage("Runtime durumumu göster. Mode, armed ve paused bilgisini söyle. Trade yapma."),
    true,
  );
  assert.equal(
    isSetupBypassReadOnlyMessage("Mevcut davranış kurallarımı özetle. Sadece oku, değiştirme."),
    true,
  );
  assert.equal(
    isSetupBypassReadOnlyMessage("Agent context snapshot çıkar. Portföy, açık pozisyon ve pending order varsa göster."),
    true,
  );
  assert.equal(
    isSetupBypassReadOnlyMessage("Solana için güvenli market brief çıkar. Hiçbir buy/sell/swap execute etme. Kaynak eksikse degraded veya unavailable de."),
    true,
  );
  assert.equal(
    isSetupBypassReadOnlyMessage("Yeni pair adaylarını değerlendir ama hiçbir buy/sell/swap execute etme. Risk verisi eksikse degraded de."),
    true,
  );
  assert.equal(isSetupBypassReadOnlyMessage("both"), false);
  assert.equal(isSetupBypassReadOnlyMessage("0x16ad3a6F473Ba57Cd944d461E48a327802b63bFa"), false);
  assert.equal(isSetupBypassReadOnlyMessage("3%"), false);
});

test("side-effect prompts are blocked while setup wizard is incomplete", () => {
  assert.equal(isSetupBlockedSideEffectMessage("0.01 SOL ile rastgele yeni bir token al."), true);
  assert.equal(isSetupBlockedSideEffectMessage("buy 0.01 SOL of BONK"), true);
  assert.equal(isSetupBlockedSideEffectMessage("control pause çalıştır"), true);
  assert.equal(isSetupBlockedSideEffectMessage("runtime arm et"), true);
  assert.equal(isSetupBlockedSideEffectMessage("both"), false);
  assert.equal(isSetupBlockedSideEffectMessage("0x16ad3a6F473Ba57Cd944d461E48a327802b63bFa"), false);
  assert.equal(isSetupBlockedSideEffectMessage("3%"), false);
});
