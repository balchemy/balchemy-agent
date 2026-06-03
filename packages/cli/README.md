<h1 align="center">
  <img src="https://www.balchemy.ai/images/balchemy-logo.svg" alt="Balchemy" width="240" />
</h1>

<p align="center">
  <strong>Balchemy CLI</strong><br/>
Initialize a local Balchemy MCP agent client, connect model credentials, set risk rules, and generate deployment files.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/v/balchemy?color=blue&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/dt/balchemy?color=green" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="node version" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license" />
  <a href="https://balchemy.ai"><img src="https://img.shields.io/badge/platform-live-balchemy.ai-purple" alt="platform" /></a>
</p>

---

## What Balchemy Does

Balchemy connects an external LLM to on-chain markets through MCP. The outer LLM
chooses tools and instructions. Balchemy applies scopes, behavior rules, risk
checks, execution, and records.

The inner LLM is infrastructure support. It fetches data and formats responses.
It does not make trading decisions.

```text
Strategy -> external LLM -> Balchemy MCP -> policy -> approved action -> record
                                  |
                                  v
                         inner LLM support
```

## Quick Start

```bash
npx balchemy
```

The wizard handles five local steps:

1. Choose an LLM provider.
2. Add the provider API key.
3. Connect a new or existing Balchemy MCP principal.
4. Review the files the CLI will write.
5. Start or export the local agent client.

New walletless agents are provisioned first. Root/recovery wallet binding happens
later in the setup chat through the authenticated MCP setup flow; until then the
agent should be treated as unbound and shadow/approval-gated.

## Commands

```bash
npx balchemy              # Setup wizard or resume cached agent
npx balchemy init         # New setup wizard
npx balchemy start        # Start from agent.config.yaml
npx balchemy list         # List saved agents
npx balchemy docker       # Generate Docker files
npx balchemy --help       # Usage
npx balchemy --version    # Version
npx balchemy --no-color   # Disable color output
```

`NO_COLOR=1` also disables colored output.

## Files Written

The CLI writes local runtime files in the current directory.

```yaml
# agent.config.yaml
llm:
  provider: anthropic
  model: selected-in-wizard

agent:
  name: my-trading-agent
  strategy: Focus on liquid markets. Keep position size below 5%.

wallets:
  solana:
    chain: solana
  evm:
    chainId: 8453
```

Secrets belong in `.env`. Do not commit that file.

## What You Can Do

### Trade

- Send trade instructions through the curated MCP surface when the backend grants the right scope.
- Keep execution behind Balchemy policy, replay/rate checks, and product approval rules.
- Use the Hub/backend contract as the source of truth for available execution tools.

### Research

- Query token price, liquidity, volume, and holder distribution.
- Check risk signals before a trade.
- Track wallets and market events.
- Compare positions across chains.

### Manage

- View portfolio, balances, positions, and PnL.
- Define behavior rules in natural language.
- Subscribe to market events.
- Rotate scoped MCP keys in Hub.

## Risk Model

Every trade path is expected to pass risk checks before execution:

- RugCheck signals.
- Honeypot simulation.
- Contract and liquidity checks.
- Behavior rule enforcement.
- Scoped MCP permissions.

The wallet remains the authority. Keep private keys and seed phrases out of
source, logs, screenshots, and prompts.

## MCP Tools

The CLI uses the curated agent-facing MCP surface returned by `tools/list`.
Availability depends on MCP key scope and backend policy.

Typical capabilities include chat/research through `ask_bot`, runtime status
through `agent_status`, walletless setup through `setup_agent`, behavior-rule
management, market-event subscriptions, and approved trade commands.

Raw/internal direct research, broad discovery, and portfolio snapshot tools stay
hidden unless they are returned by `tools/list` for that bot.

## LLM Providers

| Provider | Environment variable |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| xAI Grok | `GROK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

Pick the model in the wizard or edit `agent.config.yaml`.

## Runtime Mode

The SDK includes an `AgentLoop` for long-running agents.

```ts
import { AgentLoop } from "@balchemyai/agent-sdk";

const loop = new AgentLoop({
  mcpEndpoint: "https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID",
  apiKey: "your-mcp-api-key",
  llmProvider: "openai",
  llmApiKey: process.env.OPENAI_API_KEY ?? "",
});

await loop.start();
```

Event flow:

```text
Market event -> SSE -> external LLM evaluates -> MCP tool call -> policy/approval -> record
```

## Hub

Agents registered through the CLI appear in [Balchemy Hub](https://balchemy.ai/hub).

- Monitor portfolio, trade history, and event logs.
- Create, rotate, and revoke MCP keys.
- Keep `read` and `trade` scopes separate.
- Link Solana and EVM wallets.

## Security

- Saved agent credentials are encrypted locally. Generated `.env` files remain plaintext local secret files and must not be committed.
- MCP keys are scoped and revocable.
- Behavior rules constrain execution.
- Pre-trade checks run before approved execution.
- Seed phrases should never be stored in source or logs.

## TUI Shortcuts

| Shortcut | Action |
| --- | --- |
| `^S` | Open settings |
| `^L` | Clear chat history |
| `^N` | New agent |
| `^Q` | Quit |
| `PgUp/PgDn` | Scroll message history |
| `Esc` | Go back |

## Requirements

- Node.js 18+
- One supported LLM provider key

## Links

- [Platform](https://balchemy.ai)
- [Documentation](https://balchemy.ai/hub/docs)
- [Agent Explorer](https://balchemy.ai/explorer)
- [GitHub](https://github.com/balchemy/balchemy-agent)
- [npm: balchemy](https://www.npmjs.com/package/balchemy)
- [npm: @balchemyai/agent-sdk](https://www.npmjs.com/package/@balchemyai/agent-sdk)
- [X: @balchemyai](https://x.com/balchemyai)
- [Contact](mailto:burak@balchemy.ai)

## License

MIT
