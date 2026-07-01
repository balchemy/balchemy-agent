import test from "node:test";
import assert from "node:assert/strict";
import { getSessionBadge } from "../status-view.js";
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
    status: "starting",
    ...overrides,
  };
}

test("getSessionBadge returns SETUP when setup is required", () => {
  assert.deepEqual(getSessionBadge(makeStatus({ status: "setup-required" })), {
    label: "SETUP",
    tone: "warning",
  });
});

test("getSessionBadge returns LIVE when SSE is connected", () => {
  assert.deepEqual(getSessionBadge(makeStatus({ status: "running", sseConnected: true })), {
    label: "LIVE",
    tone: "live",
  });
});
