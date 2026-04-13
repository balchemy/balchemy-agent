# create-balchemy-agent

Deploy an autonomous AI trading agent on Solana and Base chains in 5 minutes.

## Quick Start

```bash
npx create-balchemy-agent
```

The interactive wizard will:

1. Ask you to pick an LLM provider (Anthropic, OpenAI, Gemini, Grok, OpenRouter)
2. Set up your agent with trading wallets
3. Configure your trading strategy in natural language
4. Start an interactive TUI with live chat and status panel

## Features

- **Bring Your Own LLM** — your agent, your model, your strategy
- **Interactive TUI** — split-panel chat + live status (balance, trades, events)
- **MCP Tool Calling** — your LLM calls Balchemy tools directly (trade, research, portfolio)
- **5 LLM Providers** — Anthropic, OpenAI, Gemini, Grok, OpenRouter
- **Encrypted Credentials** — AES-256-GCM at rest, PBKDF2 key derivation
- **Resume Anytime** — cached agent config, instant restart

## Commands

```bash
npx create-balchemy-agent          # Setup wizard or resume cached agent
npx create-balchemy-agent init     # Force new setup wizard
npx create-balchemy-agent start    # Start from agent.config.yaml
npx create-balchemy-agent docker   # Generate Docker deployment files
```

## How It Works

```
You (strategy) --> Your LLM (decisions) --> Balchemy MCP (execution) --> Solana/Base
```

Your LLM is the brain. Balchemy provides the infrastructure — wallets, trading, risk checks, and 100+ tools via MCP protocol. You define the strategy in natural language; your LLM decides when and what to trade.

## Requirements

- Node.js 18+
- An LLM API key (from any supported provider)

## Configuration

After setup, `agent.config.yaml` and `.env` are generated in the current directory. Edit them to change settings without re-running the wizard.

## Hub Integration

When you bind your EVM wallet during setup, the agent appears in your [Balchemy Hub](https://balchemy.ai/hub) dashboard. Use Hub for monitoring, scope management, and key rotation.

## License

MIT
