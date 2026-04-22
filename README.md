<h1 align="center">
  <img src="https://www.balchemy.ai/images/balchemy-logo.svg" alt="Balchemy" width="240" />
</h1>

<p align="center">
  <strong>Autonomous AI Trading Agent Platform</strong><br/>
  Deploy a dual-LLM trading agent on Solana and EVM chains in 5 minutes.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/v/balchemy?color=blue&label=balchemy%20(CLI)" alt="npm CLI" /></a>
  <a href="https://www.npmjs.com/package/@balchemyai/agent-sdk"><img src="https://img.shields.io/npm/v/@balchemyai/agent-sdk?color=blue&label=%40balchemyai%2Fagent-sdk" alt="npm SDK" /></a>
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/dt/balchemy?color=green" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node version" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license" />
  <a href="https://balchemy.ai"><img src="https://img.shields.io/badge/platform-live-balchemy.ai-purple" alt="platform" /></a>
</p>

---

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| [`@balchemyai/agent-sdk`](packages/sdk) | [![npm](https://img.shields.io/npm/v/@balchemyai/agent-sdk)](https://www.npmjs.com/package/@balchemyai/agent-sdk) | TypeScript SDK — MCP client, AgentLoop, onboarding, SSE streaming |
| [`balchemy`](packages/cli) | [![npm](https://img.shields.io/npm/v/balchemy)](https://www.npmjs.com/package/balchemy) | CLI tool — interactive wizard, TUI, Docker deployment |

## Quick Start

```bash
npx balchemy
```

The interactive wizard walks you through:
1. **Pick your LLM** — Anthropic, OpenAI, Gemini, Grok, or OpenRouter
2. **Set up wallets** — auto-provisioned Solana and EVM wallets
3. **Define your strategy** — natural language rules
4. **Start the 24/7 agent loop** — your LLM monitors markets and trades autonomously

```bash
npx balchemy          # Setup wizard or resume cached agent
npx balchemy init      # Force new setup wizard
npx balchemy start     # Start from agent.config.yaml
npx balchemy docker    # Generate Docker files for deployment
```

## What Is Balchemy?

Balchemy is an autonomous AI trading platform that connects your LLM to on-chain markets through the Model Context Protocol (MCP). You provide the strategy in natural language; your LLM decides when and what to trade; Balchemy handles wallets, execution, risk checks, and 100+ trading tools.

**Architecture — Dual-LLM System:**
- **External LLM** (your choice: Claude, GPT, Gemini, Grok, OpenRouter) — the brain that makes all decisions
- **Inner LLM** (GPT-5.4-mini, server-side) — infrastructure servant that fetches data, formats responses, and serves the external LLM

```
You (strategy) → External LLM (decisions) → Balchemy MCP (execution) → Solana / Base / Ethereum
                                  ↓
                        Inner LLM (data fetching, formatting)
```

## What You Can Do

### Trade
- **Buy/Sell tokens** — on Solana, Base, and Ethereum
- **Limit orders** — set price targets, get filled automatically
- **DCA (Dollar-Cost Averaging)** — schedule recurring buys
- **Trailing stops** — lock profits as price moves

### Research
- **Token analysis** — market cap, volume, holder distribution, risk scores
- **Smart money tracking** — follow profitable wallets
- **Bundle detection** — spot insider token launches
- **Price queries** — real-time Solana and EVM token prices

### Manage
- **Portfolio view** — balances, P&L, positions across chains
- **Behavior rules** — define trading constraints in natural language
- **Subscriptions** — set up alerts for market events
- **24/7 autonomous loop** — your LLM monitors and acts even when you're away

### Built-In Risk Management
Every trade passes through multi-layer safety checks:
- **RugCheck integration** — community risk scores
- **Honeypot detection** — simulated sell before buying
- **Contract verification** — liquidity locks, ownership renouncing
- **Behavior rules enforcement** — your constraints are always respected

## SDK Quick Start

```bash
npm install @balchemyai/agent-sdk
```

```typescript
import { BalchemyAgentSdk } from "@balchemyai/agent-sdk";

const sdk = new BalchemyAgentSdk({
  apiBaseUrl: "https://api.balchemy.ai/api",
});

// SIWE wallet-based onboarding
const response = await sdk.onboardWithSiwe({
  message: "SIWE_MESSAGE_FROM_WALLET",
  signature: "WALLET_SIGNATURE",
  agentId: "your-agent-id",
  scope: "trade",
});

// Connect to MCP
const mcp = sdk.connectMcp({
  endpoint: response.mcp.endpoint,
  apiKey: response.mcp.apiKey,
});

// Call tools
const portfolio = await mcp.agentPortfolio();
const reply = await mcp.askBot({ message: "What is the price of SOL?" });
const result = await mcp.tradeCommand({ message: "buy 0.1 SOL worth of BONK" });
```

See [`packages/sdk/README.md`](packages/sdk/README.md) for full API reference, auth paths, SSE streaming, and error handling.

## 100+ MCP Tools

| Tool | What It Does |
|------|-------------|
| `trade_command` | Execute buy/sell/swap on Solana or EVM |
| `ask_bot` | Natural language market queries (inner LLM-powered) |
| `agent_research` | Deep token research with technical analysis |
| `agent_portfolio` | Portfolio, positions, P&L overview |
| `configure_behavior_rules` | Set trading constraints in natural language |
| `get_behavior_rules` | Read current active rules |
| `create_subscription` | Set up market event alerts |
| `setup_agent` | Wallet provisioning and onboarding |

Plus 90+ internal tools for research, risk scoring, and execution — your LLM picks the right one from descriptions.

## 24/7 Autonomous Mode

```typescript
import { AgentLoop } from "@balchemyai/agent-sdk";

const loop = new AgentLoop(sdk, { apiKey: "balc_YOUR_KEY" });
await loop.start(); // SSE event stream + polling cycle
```

Events flow: Market event → SSE push → Your LLM evaluates → `trade_command` if relevant → Execution → Confirmation push

## Security

- **Encrypted credentials** — AES-256-GCM at rest with PBKDF2 key derivation
- **Scoped API keys** — `read` and `trade` permissions, instant revocation
- **No seed phrases stored** — all keys encrypted, never logged
- **Behavior rules** — hard constraints that even your LLM cannot override
- **Pre-trade safety checks** — RugCheck, honeypot detection, contract verification

## Supported LLM Providers

| Provider | Environment Variable | Notes |
|-----------|---------------------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | Claude 3.5 Sonnet, Opus, etc. |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, GPT-5, etc. |
| Google Gemini | `GEMINI_API_KEY` | Gemini 1.5 Pro, Flash |
| xAI Grok | `GROK_API_KEY` | Grok-4-1-fast for research |
| OpenRouter | `OPENROUTER_API_KEY` | Access to 100+ models |

## Hub Integration

When you bind your EVM wallet during setup, your agent appears in your [Balchemy Hub](https://balchemy.ai/hub) dashboard:
- **Monitor** — live portfolio, trade history, event log
- **API Keys** — create, rotate, and revoke MCP keys with scoped permissions
- **Scope Management** — `read` for data-only, `trade` for full execution
- **Wallet Management** — link/unlink Solana and EVM wallets

## Built On

Built on [Google Cloud](https://cloud.google.com/) Compute Engine infrastructure, powering our dual-LLM architecture and 100+ MCP tool execution pipeline.

## Links

- **Platform:** [balchemy.ai](https://balchemy.ai)
- **Documentation:** [balchemy.ai/hub/docs](https://balchemy.ai/hub/docs)
- **Agent Explorer:** [balchemy.ai/explorer](https://balchemy.ai/explorer)
- **GitHub:** [github.com/balchemy/balchemy-agent](https://github.com/balchemy/balchemy-agent)
- **npm:** [balchemy](https://www.npmjs.com/package/balchemy) · [@balchemyai/agent-sdk](https://www.npmjs.com/package/@balchemyai/agent-sdk)
- **X:** [@balchemyai](https://x.com/balchemyai)
- **Contact:** [burak@balchemy.ai](mailto:burak@balchemy.ai)

## License

MIT
