import test from "node:test";
import assert from "node:assert/strict";
import type { BalchemyMcpClient } from "@balchemyai/agent-sdk";
import { ChatAgent } from "../ChatAgent.js";

type ChatAgentHarness = {
  history: Array<{ role: string; content: string }>;
  callLlm: () => Promise<{ text: string }>;
  chat: (message: string) => Promise<string>;
};

test("ChatAgent serializes overlapping chat calls", async () => {
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
    },
    {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
    } as unknown as BalchemyMcpClient,
    fetch,
  ) as unknown as ChatAgentHarness;

  agent.history = [{ role: "system", content: "test" }];

  let active = 0;
  let maxActive = 0;

  agent.callLlm = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return { text: "ok" };
  };

  const [a, b] = await Promise.all([agent.chat("first"), agent.chat("second")]);

  assert.equal(a, "ok");
  assert.equal(b, "ok");
  assert.equal(maxActive, 1);
});
