import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString } from "ink";
import { ChatPanel } from "../ChatPanel.js";
import { calculateChatViewportRows } from "../App.js";
import type { ChatMessage } from "../types.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
}

test("Ink activity focus render exposes wrapped system rows without prompt chrome", () => {
  const longToolText = `Tool: agent_market_brief ${Array.from({ length: 14 }, (_, index) => `candidate-${index}`).join(" ")}`;
  const rendered = stripAnsi(renderToString(
    <ChatPanel
      messages={[
        {
          id: "system-1",
          type: "system",
          text: longToolText,
          timestamp: Date.parse("2026-02-11T00:00:00.000Z"),
        },
      ]}
      onSend={() => {}}
      inputActive={false}
      hideInput
      copyMode
      pageSize={8}
      width={72}
    />,
  ));

  assert.match(rendered, /agent_market_brief/);
  assert.match(rendered, /candidate-0/);
  assert.match(rendered, /candidate-13/);
  assert.doesNotMatch(rendered, /Prompt/);
  assert.doesNotMatch(rendered, /[╭╮╰╯│]/);
});

test("chat viewport reserves prompt chrome so transcript rows do not collide with input", () => {
  const messages: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({
    id: `msg-${index}`,
    type: index % 2 === 0 ? "user" : "agent",
    text: `message-${index} ${"token ".repeat(8)}`,
    timestamp: Date.parse("2026-02-11T00:00:00.000Z") + index * 1000,
  }));
  const pageSize = calculateChatViewportRows(16, false);
  const rendered = stripAnsi(renderToString(
    <ChatPanel
      messages={messages}
      onSend={() => {}}
      inputActive
      pageSize={pageSize}
      width={92}
    />,
  ));
  const lines = rendered.split("\n");
  const promptLines = lines.filter((line) => line.includes("Prompt"));

  assert.equal(pageSize, 8);
  assert.equal(promptLines.length, 1);
  assert.doesNotMatch(promptLines[0] ?? "", /\b(?:AI|YOU|TOOL|ERROR|NOTE)\b/);
  assert.doesNotMatch(promptLines[0] ?? "", /message-\d+/);
  assert.doesNotMatch(rendered, /message-0/);
  assert.match(rendered, /message-11/);
});
