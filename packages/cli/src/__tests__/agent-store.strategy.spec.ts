import test from "node:test";
import assert from "node:assert/strict";
import {
  type StoredAgent,
  withUpdatedAgentStrategy,
} from "../agent-store.js";

test("withUpdatedAgentStrategy keeps summary strategy and behavior rules aligned", () => {
  const agent: StoredAgent = {
    publicId: "agent-1",
    mcpEndpoint: "https://example.com/mcp/agent-1",
    apiKey: "balc_test",
    llmProvider: "openai",
    llmApiKey: "key",
    strategy: "old strategy",
    shadowMode: true,
    behaviorRules: {
      rules: "old strategy",
      maxTradeSol: 0.05,
    },
    createdAt: "2026-04-20T00:00:00.000Z",
  };

  const updated = withUpdatedAgentStrategy(agent, "new strategy");

  assert.equal(updated.strategy, "new strategy");
  assert.deepEqual(updated.behaviorRules, {
    rules: "new strategy",
    maxTradeSol: 0.05,
  });
  assert.equal(agent.strategy, "old strategy");
});
