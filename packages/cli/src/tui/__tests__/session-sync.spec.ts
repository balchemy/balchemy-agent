import test from "node:test";
import assert from "node:assert/strict";
import type { StoredAgent } from "../../agent-store.js";
import {
  buildStrategyUpdateArgs,
  persistStrategyAndBuildRestartConfig,
} from "../session-sync.js";

test("persistStrategyAndBuildRestartConfig keeps runtime config in sync after remote strategy edits", () => {
  const agent: StoredAgent = {
    publicId: "agent-1",
    mcpEndpoint: "https://example.com/mcp/agent-1",
    apiKey: "balc_test",
    llmProvider: "openai",
    llmApiKey: "key",
    llmModel: "gpt-5.4-mini",
    llmTimeoutMs: 15000,
    strategy: "old strategy",
    shadowMode: true,
    behaviorRules: {
      rules: "old strategy",
      maxTradeSol: 0.05,
    },
    createdAt: "2026-04-20T00:00:00.000Z",
  };

  const saved: StoredAgent[] = [];
  const result = persistStrategyAndBuildRestartConfig({
    agent,
    strategy: "new strategy",
    saveAgent: (updated) => saved.push(updated),
  });

  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.strategy, "new strategy");
  assert.equal(result.agent.strategy, "new strategy");
  assert.equal(result.restartConfig.strategy, "new strategy");
  assert.deepEqual(result.restartConfig.behaviorRules, {
    rules: "new strategy",
    maxTradeSol: 0.05,
  });
  assert.equal(result.restartConfig.autoSeedSubscriptions, false);
});

test("buildStrategyUpdateArgs preserves current shadow mode", () => {
  assert.deepEqual(buildStrategyUpdateArgs("new strategy", true), {
    action: "configure_autonomous",
    naturalLanguageRules: "new strategy",
    shadowMode: true,
  });
});
