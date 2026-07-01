import test from "node:test";
import assert from "node:assert/strict";
import type { BalchemyMcpClient } from "@balchemyai/agent-sdk";
import { ChatAgent, makeSyntheticToolCallId } from "../ChatAgent.js";
import { buildTradeConfirmationDetails } from "../trade-confirmation.js";

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

test("ChatAgent synthetic tool call ids stay within OpenAI message limits", () => {
  const id = makeSyntheticToolCallId("readiness-agent_readiness_report");

  assert.ok(id.length <= 64);
  assert.match(id, /^[a-zA-Z0-9_-]+$/);
});

test("ChatAgent system prompt separates shadow monitoring from live execution arming", async () => {
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      publicId: "agent-trade",
    },
    {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
    } as unknown as BalchemyMcpClient,
    fetch,
  ) as unknown as ChatAgentHarness;

  await (agent as unknown as ChatAgent).init();

  const prompt = agent.history[0]?.content ?? "";
  assert.match(prompt, /Shadow mode can still monitor, scan, and emit read-only recommendations/);
  assert.match(prompt, /armed=false only blocks live execution/);
  assert.match(prompt, /Do not say "not in loop because armed=false\."/);
  assert.match(prompt, /SOURCE_INGEST_NOT_CONFIGURED/);
});

test("ChatAgent serializes overlapping chat calls", async () => {
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      publicId: "agent-trade",
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
      publicId: "agent-trade",
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
            arguments: JSON.stringify({
              action: "buy",
              amount: "0.1",
              token: "So11111111111111111111111111111111111111112",
              chain: "solana",
              evidenceId: "risk-report-1",
              sourceHealth: { status: "healthy" },
              missingFacts: [],
              exitPolicy: "take profit at 2x or stop loss at 20%",
            }),
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
  assert.equal(mcpCalls[0].name, "trade_command");
  assert.equal(mcpCalls[0].args.chat_id, "cli-agent-trade");
  assert.match(String(mcpCalls[0].args.idempotency_key), /^cli-/);
  assert.ok(Array.isArray(mcpCalls[0].args.recent_messages));
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

test("ChatAgent blocks self-selected evidence-free trade_command calls before confirmation", async () => {
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
            arguments: JSON.stringify({
              action: "buy",
              amount: "0.1",
              token: "So11111111111111111111111111111111111111112",
              chain: "solana",
              message: "kendin bulup al",
              selfSelected: true,
            }),
          },
        }],
      };
    }
    return { text: "blocked" };
  };

  let confirmationCalls = 0;
  const reply = await agent.chat("buy", undefined, async () => {
    confirmationCalls += 1;
    return true;
  });

  assert.equal(reply, "blocked");
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(mcpCalls, []);
  const blockedToolResult = agent.history.find((entry) => entry.role === "tool")?.content ?? "";
  assert.match(blockedToolResult, /missing execution evidence/);
});

test("Trade confirmation blocks autonomous trades with required approvals", () => {
  const details = buildTradeConfirmationDetails({
    action: "buy",
    amount: "0.1",
    token: "So11111111111111111111111111111111111111112",
    chain: "solana",
    selfSelected: true,
    evidenceId: "asset:sol",
    sourceHealth: { status: "healthy" },
    missingFacts: [],
    requiredApprovals: ["manual_review"],
    exitPolicy: "take profit at 2x or stop loss at 20%",
  });

  assert.equal(details.canApprove, false);
  assert.match(details.blockReason ?? "", /missing execution evidence/);
});

test("Trade confirmation does not map Ethereum requests to Base", () => {
  const details = buildTradeConfirmationDetails({
    message: "buy 0.1 ETH of 0x1111111111111111111111111111111111111111 on ethereum",
  });

  assert.equal(details.canApprove, false);
  assert.match(details.blockReason ?? "", /missing chain/);
});

test("Trade confirmation blocks chain and token address mismatch", () => {
  const details = buildTradeConfirmationDetails({
    action: "buy",
    amount: "0.1",
    amountUnit: "SOL",
    token: "0x1111111111111111111111111111111111111111",
    chain: "solana",
  });

  assert.equal(details.canApprove, false);
  assert.match(details.blockReason ?? "", /chain\/token mismatch/);
});

test("ChatAgent uses recent self-selection context to block later exact-looking trade_command calls without evidence", async () => {
  const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      publicId: "agent-context-self-select",
    },
    {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        mcpCalls.push({ name, args });
        return { content: [{ type: "text", text: "market brief: exact candidate found" }] };
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
            name: "trade_command",
            arguments: JSON.stringify({
              action: "buy",
              amount: "0.1",
              token: "So11111111111111111111111111111111111111112",
              chain: "solana",
            }),
          },
        }],
      };
    }
    return { text: "blocked" };
  };

  let confirmationCalls = 0;
  const reply = await agent.chat("0.1 SOL ile kendin bulup al", undefined, async () => {
    confirmationCalls += 1;
    return true;
  });

  assert.equal(reply, "blocked");
  assert.equal(confirmationCalls, 0);
  assert.deepEqual(mcpCalls, [{
    name: "agent_market_brief",
    args: {
      query: "0.1 SOL ile kendin bulup al",
      chain: "solana",
      chat_id: "cli-agent-context-self-select",
    },
  }]);
  const blockedToolResult = agent.history.find((entry) => entry.role === "tool" && entry.content.includes("Trade blocked before MCP call"))?.content ?? "";
  assert.match(blockedToolResult, /missing execution evidence/);
});

test("ChatAgent allows exact user-selected trade preview without autonomous evidence fields", async () => {
  const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      chatId: "cli-agent-exact-trade",
    },
    {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        mcpCalls.push({ name, args });
        return { content: [{ type: "text", text: "accepted" }] };
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

  let confirmationCalls = 0;
  const reply = await agent.chat("buy this exact token", undefined, async () => {
    confirmationCalls += 1;
    return true;
  });

  assert.equal(reply, "done");
  assert.equal(confirmationCalls, 1);
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].name, "trade_command");
});

test("ChatAgent treats self-selection trade language as read-only discovery before any trade", async () => {
  const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      publicId: "agent-self-select",
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
  assert.equal(mcpCalls.length, 1);
  assert.equal(mcpCalls[0].name, "agent_market_brief");
  assert.deepEqual(mcpCalls[0].args, {
    query: userMessage,
    chain: "solana",
    chat_id: "cli-agent-self-select",
  });
  assert.deepEqual(toolEvents.map((event) => event.name), ["agent_market_brief"]);
  assert.equal(agent.history[2]?.tool_calls?.[0]?.function.name, "agent_market_brief");
  const systemMessages = agent.history.filter((entry) => entry.role === "system");
  assert.match(systemMessages[systemMessages.length - 1]?.content ?? "", /not a random trade/);
});

test("ChatAgent uses deterministic readiness report for status diagnostics", async () => {
  const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      publicId: "agent-ready",
    },
    {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        mcpCalls.push({ name, args });
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              reply: "Readiness report ready: blockers remain.",
              structured: {
                actionEligibility: {
                  status: "blocked",
                  codes: ["RUNTIME_NOT_LIVE_ARMED"],
                },
              },
            }),
          }],
        };
      },
    } as unknown as BalchemyMcpClient,
    fetch,
  ) as unknown as ChatAgentHarness;

  agent.history = [{ role: "system", content: "test" }];
  agent.tools = [{
    name: "agent_readiness_report",
    description: "Readiness report",
    inputSchema: { type: "object", properties: {} },
  }];
  agent.callLlm = async () => ({ text: "Runtime is not live armed." });

  const reply = await agent.chat("durum ve readiness göster");

  assert.equal(reply, "Runtime is not live armed.");
  assert.deepEqual(mcpCalls, [{
    name: "agent_readiness_report",
    args: { chat_id: "cli-agent-ready" },
  }]);
  const readinessToolCallId = agent.history
    .find((entry) =>
      entry.role === "assistant" &&
      entry.tool_calls?.[0]?.function.name === "agent_readiness_report"
    )
    ?.tool_calls?.[0]?.id ?? "";
  assert.ok(readinessToolCallId.length > 0);
  assert.ok(readinessToolCallId.length <= 64);
  const systemMessages = agent.history.filter((entry) => entry.role === "system");
  assert.match(systemMessages[systemMessages.length - 1]?.content ?? "", /agent_readiness_report/);
});

test("ChatAgent follows backend suggestedTool redirects for broad discovery", async () => {
  const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      publicId: "agent-redirect",
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
    { name: "agent_candidate_report", args: { query: "solana yeni launch tara", chain: "solana", chat_id: "cli-agent-redirect" } },
    { name: "agent_market_brief", args: { query: "solana yeni launch tara", chain: "solana", chat_id: "cli-agent-redirect" } },
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
      publicId: "agent-ticker",
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
  assert.deepEqual(mcpCalls, [{ name: "agent_candidate_report", args: { query: "BONK", chain: "solana", chat_id: "cli-agent-ticker" } }]);
});

test("ChatAgent injects stable chat_id into session-aware read tools", async () => {
  const mcpCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const agent = new ChatAgent(
    {
      llmProvider: "openai",
      llmApiKey: "test-key",
      llmModel: "gpt-5.4-mini",
      publicId: "agent-context",
    },
    {
      listTools: async () => ({ tools: [] }),
      callTool: async (name: string, args: Record<string, unknown>) => {
        mcpCalls.push({ name, args });
        return { content: [{ type: "text", text: "ok" }] };
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
          id: "call-ctx",
          type: "function",
          function: {
            name: "agent_risk_report",
            arguments: JSON.stringify({ query: "0x1111111111111111111111111111111111111111", chain: "base" }),
          },
        }],
      };
    }
    return { text: "done" };
  };

  await agent.chat("risk bak");

  assert.equal(mcpCalls[0].name, "agent_risk_report");
  assert.equal(mcpCalls[0].args.chat_id, "cli-agent-context");
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
