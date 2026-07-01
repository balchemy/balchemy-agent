import test from "node:test";
import assert from "node:assert/strict";
import { sameVisibleStatus } from "../App.js";
import {
  buildTuiLoopNoticeFingerprint,
  formatTuiLoopNotice,
  normalizeTuiLoopNoticeAction,
  shouldCountTuiActivityEvent,
} from "../AgentBridge.js";
import type { StatusData } from "../types.js";

function makeStatus(overrides: Partial<StatusData> = {}): StatusData {
  return {
    balanceSol: 0,
    balanceUsd: 0,
    wallets: [],
    activeTrades: [],
    eventsReceived: 0,
    decisionsExecuted: 0,
    tradesExecuted: 0,
    llmCostToday: 0,
    maxDailyLlmCost: 5,
    uptime: 0,
    sseConnected: false,
    status: "running",
    ...overrides,
  };
}

test("sameVisibleStatus ignores uptime changes that do not change displayed seconds", () => {
  assert.equal(
    sameVisibleStatus(
      makeStatus({ uptime: 1200 }),
      makeStatus({ uptime: 1750 }),
    ),
    true,
  );
});

test("sameVisibleStatus detects visible status changes", () => {
  assert.equal(
    sameVisibleStatus(
      makeStatus({ eventsReceived: 1 }),
      makeStatus({ eventsReceived: 2 }),
    ),
    false,
  );
});

test("TUI activity counter ignores heartbeat and internal stream frames", () => {
  assert.equal(shouldCountTuiActivityEvent("heartbeat", undefined), false);
  assert.equal(shouldCountTuiActivityEvent("ping", undefined), false);
  assert.equal(shouldCountTuiActivityEvent("message", undefined), false);
});

test("TUI activity counter counts subscription frames with visible events", () => {
  assert.equal(
    shouldCountTuiActivityEvent("subscription_event", { delta: { events: [{ key: "mint" }] } }),
    true,
  );
  assert.equal(
    shouldCountTuiActivityEvent("subscription_event", { delta: { events: [] } }),
    false,
  );
});

test("TUI loop notice helpers classify and fingerprint non-executing outcomes", () => {
  assert.equal(normalizeTuiLoopNoticeAction("degraded"), "degraded");
  assert.equal(normalizeTuiLoopNoticeAction("blocked"), "blocked");
  assert.equal(normalizeTuiLoopNoticeAction("hold"), "blocked");
  assert.equal(normalizeTuiLoopNoticeAction("buy"), null);

  const first = buildTuiLoopNoticeFingerprint(
    "degraded",
    "Degraded: Source health is missing.",
    "TOKEN",
    "0.01",
  );
  const second = buildTuiLoopNoticeFingerprint(
    "degraded",
    "source health is missing.",
    "token",
    "0.01",
  );
  assert.equal(first, second);
  assert.equal(
    formatTuiLoopNotice("blocked", " Fresh evidence is missing. "),
    "Blocked: Fresh evidence is missing.",
  );
});
