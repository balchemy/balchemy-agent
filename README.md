# Balchemy Agent

Autonomous AI trading agent infrastructure for Solana and Base chains.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@balchemyai/agent-sdk`](packages/sdk) | [![npm](https://img.shields.io/npm/v/@balchemyai/agent-sdk)](https://www.npmjs.com/package/@balchemyai/agent-sdk) | TypeScript SDK — MCP client, AgentLoop, onboarding |
| [`create-balchemy-agent`](packages/cli) | [![npm](https://img.shields.io/npm/v/create-balchemy-agent)](https://www.npmjs.com/package/create-balchemy-agent) | CLI tool — interactive wizard + TUI |

## Quick Start

```bash
npx create-balchemy-agent
```

Pick your LLM, set your strategy, start trading — all from your terminal.

## How It Works

```
You (strategy) → Your LLM (decisions) → Balchemy MCP (execution) → Solana/Base
```

Your LLM is the brain. Balchemy provides the infrastructure — wallets, trading, risk checks, and 100+ tools via MCP protocol.

## For Developers

```bash
npm install @balchemyai/agent-sdk
```

```typescript
import { connectMcp, AgentLoop } from "@balchemyai/agent-sdk";

const mcp = connectMcp({
  endpoint: "https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID",
  apiKey: "balc_YOUR_API_KEY",
});

// Call tools directly
const portfolio = await mcp.callTool("agent_portfolio", {});

// Or run a 24/7 autonomous loop
const loop = new AgentLoop({
  mcpEndpoint: "https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID",
  apiKey: "balc_YOUR_API_KEY",
  llmProvider: "openai",
  llmApiKey: "sk-...",
  llmModel: "gpt-5.4-mini",
  onDecision: (d) => console.log(d.action, d.token, d.reasoning),
});
await loop.start();
```

## Supported LLM Providers

- Anthropic (Claude)
- OpenAI (GPT)
- Google (Gemini)
- xAI (Grok)
- OpenRouter (multi-provider)

## License

MIT
