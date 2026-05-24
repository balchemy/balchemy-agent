import test from "node:test";
import assert from "node:assert/strict";
import type { BalchemyMcpClient } from "@balchemyai/agent-sdk";
import { ChatAgent } from "../ChatAgent.js";

type ChatAgentHarness = {
  history: Array<{ role: string; content: string }>;
  callLlm: () => Promise<{
    text: string;
    toolCalls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  callTextOnly: (systemPrompt: string, userMessage: string) => Promise<string>;
  chat: ChatAgent["chat"];
  completeText: (systemPrompt: string, userMessage: string) => Promise<string>;
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

test("ChatAgent sends structured trade details to confirmation callback", async () => {
  const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
    },
    {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        mcpCalls.push({ name, args });
        return { content: [{ type: "text", text: "executed" }] };
      },
    } as unknown as BalchemyMcpClient,
    fetch,
  ) as unknown as ChatAgentHarness;

  agent.history = [{ role: "system", content: "test" }];
  let rounds = 0;
  agent.callLlm = async () => {
    rounds += 1;
    if (rounds === 1) {
      return {
        text: "",
        toolCalls: [{
          id: "call-1",
          type: "function",
          function: {
            name: "trade_command",
            arguments: JSON.stringify({ action: "buy", amount: "0.1", token: "So11111111111111111111111111111111111111112", chain: "solana" }),
          },
        }],
      };
    }
    return { text: "done" };
  };

  const seen: Array<{ preview: string; token: string; amount: string; chain: string }> = [];
  const reply = await agent.chat("buy", undefined, async (details) => {
    seen.push({
      preview: details.preview,
      token: details.token,
      amount: details.amount,
      chain: details.chain,
    });
    return true;
  });

  assert.equal(reply, "done");
  assert.deepEqual(seen, [{
    preview: "BUY 0.1 SOL → So111111111111111",
    token: "So11111111111111111111111111111111111111112",
    amount: "0.1",
    chain: "solana",
  }]);
  assert.equal(mcpCalls.length, 1);
});

test("ChatAgent text-only completions share the chat queue", async () => {
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
    return { text: "chat" };
  };
  agent.callTextOnly = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    return "coach";
  };

  const [chat, coach] = await Promise.all([
    agent.chat("regular"),
    agent.completeText("system", "strategy"),
  ]);

  assert.equal(chat, "chat");
  assert.equal(coach, "coach");
  assert.equal(maxActive, 1);
});
