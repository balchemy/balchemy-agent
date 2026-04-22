<h1 align="center">
  <img src="https://www.balchemy.ai/images/balchemy-logo.svg" alt="Balchemy" width="240" />
</h1>

<p align="center">
  <strong>Autonomous AI Trading Agent Platform</strong><br/>
  Deploy a dual-LLM trading agent on Solana and EVM chains in 5 minutes.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/v/balchemy?color=blue&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/dt/balchemy?color=green" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node version" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license" />
  <a href="https://balchemy.ai"><img src="https://img.shields.io/badge/platform-live-balchemy.ai-purple" alt="platform" /></a>
</p>

---

## What Is Balchemy?

Balchemy is an autonomous AI trading platform that connects your LLM to on-chain markets through the Model Context Protocol (MCP). You provide the strategy in natural language; your LLM decides when and what to trade; Balchemy handles wallets, execution, risk checks, and 100+ trading tools.

**Architecture — Dual-LLM System:**
- **External LLM** (your choice: Claude, GPT, Gemini, Grok, OpenRouter) — the brain that makes all decisions
- **Inner LLM** (GPT-5.4-mini, server-side) — infrastructure servant that fetches data, formats responses, and serves the external LLM

Your LLM calls Balchemy tools via MCP — it picks the right tool from natural language descriptions, not hardcoded tool names.

```
You (strategy) → External LLM (decisions) → Balchemy MCP (execution) → Solana / Base / Ethereum
                                  ↓
                        Inner LLM (data fetching, formatting)
```

## Quick Start

```bash
npx balchemy
```

The interactive wizard walks you through:
1. **Pick your LLM** — Anthropic, OpenAI, Gemini, Grok, or OpenRouter
2. **Set up wallets** — auto-provisioned Solana and EVM wallets
3. **Define your strategy** — natural language rules ("max 5% position size, only trade on Solana")
4. **Start the 24/7 agent loop** — your LLM monitors markets and trades autonomously

```bash
npx balchemy          # Setup wizard or resume cached agent
npx balchemy init      # Force new setup wizard
npx balchemy start     # Start from agent.config.yaml
npx balchemy docker    # Generate Docker files for deployment
```

## What You Can Do

### Trade
- **Buy/Sell tokens** — `buy 0.1 SOL worth of BONK on Solana`
- **Limit orders** — set price targets, get filled automatically
- **DCA (Dollar-Cost Averaging)** — schedule recurring buys
- **Trailing stops** — lock profits as price moves

### Research
- **Token analysis** — market cap, volume, holder distribution, risk scores
- **Smart money tracking** — follow profitable wallets
- **Bundle detection** — spot insider token launches
- **Price queries** — real-time Solana and EVM token prices

### Manage
- **Portfolio view** — see balances, P&L, positions across chains
- **Behavior rules** — define trading constraints in natural language
- **Subscriptions** — set up alerts for market events
- **24/7 autonomous loop** — your LLM monitors and acts even when you're away

### Risk Management (Built-In)
Every trade passes through multi-layer safety checks before execution:
- **RugCheck integration** — community risk scores
- **Honeypot detection** — simulated sell before buying
- **Contract verification** — liquidity locks, ownership renouncing
- **Behavior rules enforcement** — your constraints are always respected

## 100+ MCP Tools

Your LLM accesses Balchemy through these primary agent-facing tools:

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

## LLM Providers

| Provider | Environment Variable | Notes |
|-----------|---------------------|-------|
| Anthropic | `ANTHROPIC_API_KEY` | Haiku 4.5, Sonnet 4.6, Opus 4.6+ |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, GPT-5.4, etc. |
| Google Gemini | `GEMINI_API_KEY` | Gemini 3.1 Pro, Flash |
| Google Vertex AI | `GOOGLE_APPLICATION_CREDENTIALS` | Gemini 3.1 Pro via Vertex AI |
| xAI Grok | `GROK_API_KEY` | Grok-4-1-fast for research |
| OpenRouter | `OPENROUTER_API_KEY` | Access to 100+ models |
| Google Vertex AI | `GOOGLE_APPLICATION_CREDENTIALS` | Gemini 3.1 Pro via Vertex AI |

## Configuration

After setup, `agent.config.yaml` and `.env` are generated in the current directory:

```yaml
# agent.config.yaml
llm:
  provider: anthropic
  model: claude-sonnet-4-20250514

agent:
  name: my-trading-agent
  strategy: Focus on Solana memecoins with high volume and positive sentiment

wallets:
  solana:
    chain: solana
  evm:
    chainId: 8453  # Base
```

Edit these files to change settings without re-running the wizard.

## 24/7 Autonomous Mode

The SDK includes an `AgentLoop` that keeps your LLM connected to Balchemy permanently:

```ts
import { BalchemyAgentSdk, AgentLoop } from "@balchemyai/agent-sdk";

const sdk = new BalchemyAgentSdk({ apiBaseUrl: "https://api.balchemy.ai/api" });
const loop = new AgentLoop(sdk, { apiKey: "your-mcp-api-key" });

// Starts SSE event stream + polling cycle
// Your LLM receives market events and decides whether to act
await loop.start();
```

Events flow: Market event → SSE push → Your LLM evaluates → `trade_command` if relevant → Execution → Confirmation push

## Hub Integration

When you bind your EVM wallet during setup, your agent appears in your [Balchemy Hub](https://balchemy.ai/hub) dashboard:
- **Monitor** — live portfolio, trade history, event log
- **API Keys** — create, rotate, and revoke MCP keys with scoped permissions
- **Scope Management** — `read` for data-only, `trade` for full execution
- **Wallet Management** — link/unlink Solana and EVM wallets

## Security

- **Encrypted credentials** — AES-256-GCM at rest with PBKDF2 key derivation
- **Scoped API keys** — `read` and `trade` permissions, instant revocation
- **No seed phrases stored** — all keys encrypted, never logged
- **Behavior rules** — hard constraints that even your LLM cannot override
- **Pre-trade safety checks** — RugCheck, honeypot detection, contract verification

## Requirements

- Node.js 18+
- An LLM API key from any supported provider

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