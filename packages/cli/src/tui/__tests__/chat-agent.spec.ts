import test from "node:test";
import assert from "node:assert/strict";
import type { BalchemyMcpClient } from "@balchemyai/agent-sdk";
import { ChatAgent } from "../ChatAgent.js";

type ChatAgentHarness = {
  history: Array<{
    role: string;
    content: string;
    tool_calls?: Array<{
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    }>;
  }>;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
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

  const seen: Array<{ preview: string; token: string; amount: string; chain: string; approvalPhrase: string }> = [];
  const reply = await agent.chat("buy", undefined, async (details) => {
    seen.push({
      preview: details.preview,
      token: details.token,
      amount: details.amount,
      chain: details.chain,
      approvalPhrase: details.approvalPhrase,
    });
    return true;
  });

  assert.equal(reply, "done");
  assert.deepEqual(seen, [{
    preview: "BUY 0.1 SOL -> So111111...111112",
    token: "So11111111111111111111111111111111111111112",
    amount: "0.1",
    chain: "solana",
    approvalPhrase: "TRADE BUY SOLANA 0.1 So111111...111112",
  }]);
  assert.equal(mcpCalls.length, 1);
});

test("ChatAgent blocks incomplete or random trade previews before confirmation and MCP call", async () => {
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
            arguments: JSON.stringify({ message: "buy 0.01 SOL of a random new token" }),
          },
        }],
      };
    }
    return { text: "blocked" };
  };

  let confirmationCalls = 0;
  const toolEvents: Array<{ name: string; result: string }> = [];
  const reply = await agent.chat(
    "0.01 SOL ile rastgele yeni bir token al",
    (name, result) => toolEvents.push({ name, result }),
    async () => {
      confirmationCalls += 1;
      return true;
    },
  );

  assert.equal(reply, "blocked");
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(mcpCalls, []);
  assert.deepEqual(toolEvents, []);
  const blockedToolResult = agent.history.find((entry) => entry.role === "tool")?.content ?? "";
  assert.match(blockedToolResult, /Trade blocked before MCP call/);
  assert.match(blockedToolResult, /Random or unknown token/);
});

test("ChatAgent treats self-selection trade language as read-only discovery before any trade", async () => {
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
        return { content: [{ type: "text", text: "market-brief: ROHAT, CALEB; risk degraded" }] };
      },
    } as unknown as BalchemyMcpClient,
    fetch,
  ) as unknown as ChatAgentHarness;

  agent.history = [{ role: "system", content: "test" }];
  agent.tools = [{
    name: "agent_market_brief",
    description: "Broad market discovery",
    inputSchema: { type: "object", properties: {} },
  }];
  agent.callLlm = async () => ({ text: "Önce safe discovery yaptım; risk degraded olduğu için trade göndermiyorum." });

  let confirmationCalls = 0;
  const toolEvents: Array<{ name: string; result: string }> = [];
  const userMessage = "0.01 SOL ile kendin bulup alabilrisin";
  const reply = await agent.chat(
    userMessage,
    (name, result) => toolEvents.push({ name, result }),
    async () => {
      confirmationCalls += 1;
      return true;
    },
  );

  assert.equal(reply, "Önce safe discovery yaptım; risk degraded olduğu için trade göndermiyorum.");
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(mcpCalls, [{
    name: "agent_market_brief",
    args: { query: userMessage, chain: "solana" },
  }]);
  assert.deepEqual(toolEvents.map((event) => event.name), ["agent_market_brief"]);
  assert.equal(agent.history[2]?.tool_calls?.[0]?.function.name, "agent_market_brief");
  const systemMessages = agent.history.filter((entry) => entry.role === "system");
  assert.match(systemMessages[systemMessages.length - 1]?.content ?? "", /not a random trade/);
});

test("ChatAgent follows backend suggestedTool redirects for broad discovery", async () => {
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
        if (name === "agent_candidate_report") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                reply: "Use agent_market_brief for broad scans.",
                structured: {
                  query: "solana yeni launch tara",
                  suggestedTool: "agent_market_brief",
                },
              }),
            }],
          };
        }
        return { content: [{ type: "text", text: "discovery-result" }] };
      },
    } as unknown as BalchemyMcpClient,
    fetch,
  ) as unknown as ChatAgentHarness;

  agent.history = [{ role: "system", content: "test" }];
  agent.tools = [{
    name: "agent_market_brief",
    description: "Broad market discovery",
    inputSchema: { type: "object", properties: {} },
  }];
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
            name: "agent_candidate_report",
            arguments: JSON.stringify({ query: "solana yeni launch tara", chain: "solana" }),
          },
        }],
      };
    }
    return { text: "launches checked" };
  };

  const toolEvents: Array<{ name: string; result: string }> = [];
  const reply = await agent.chat("solana yeni launch tara", (name, result) => {
    toolEvents.push({ name, result });
  });

  assert.equal(reply, "launches checked");
  assert.deepEqual(mcpCalls, [
    { name: "agent_candidate_report", args: { query: "solana yeni launch tara", chain: "solana" } },
    { name: "agent_market_brief", args: { query: "solana yeni launch tara", chain: "solana" } },
  ]);
  assert.deepEqual(toolEvents.map((event) => event.name), ["agent_candidate_report", "agent_market_brief"]);
  assert.equal(agent.history[2]?.tool_calls?.[0]?.function.name, "agent_candidate_report");
  assert.equal(agent.history[4]?.tool_calls?.[0]?.function.name, "agent_market_brief");
});

test("ChatAgent leaves explicit ticker research for LLM tool selection", async () => {
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
        return { content: [{ type: "text", text: "research-result" }] };
      },
    } as unknown as BalchemyMcpClient,
    fetch,
  ) as unknown as ChatAgentHarness;

  agent.history = [{ role: "system", content: "test" }];
  agent.tools = [{
    name: "agent_market_brief",
    description: "Broad market discovery",
    inputSchema: { type: "object", properties: {} },
  }];
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
            name: "agent_candidate_report",
            arguments: JSON.stringify({ query: "BONK", chain: "solana" }),
          },
        }],
      };
    }
    return { text: "researched" };
  };

  const reply = await agent.chat("BONK araştır");

  assert.equal(reply, "researched");
  assert.deepEqual(mcpCalls, [{ name: "agent_candidate_report", args: { query: "BONK", chain: "solana" } }]);
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
