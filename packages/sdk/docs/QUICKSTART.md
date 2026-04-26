# Balchemy Agent — Quickstart

Get an autonomous trading agent running in under 5 minutes.

---

## Prerequisites

- Node.js 18+ (or Docker)
- A Balchemy account with at least one agent created in the Hub
- An API key from Hub > Agents > your agent > API Keys
- An LLM API key (Anthropic or OpenAI)

---

## Step 1: Create an agent in the Hub

1. Go to [balchemy.ai](https://balchemy.ai) and sign in
2. Open Hub > Agents > New Agent
3. Complete the setup wizard (wallets, trading config, connect)
4. Copy the MCP endpoint from the API tab: `https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID`
5. Generate an API key and copy it (shown once)

---

## Step 2: Run the setup wizard

```bash
npx balchemy
```

The wizard asks:
- MCP endpoint
- Balchemy API key
- LLM provider (Anthropic or OpenAI) + API key + model
- Daily LLM budget (USD)
- Strategy preset

It writes `agent.config.yaml` and `.env` to the current directory.

---

## Step 3: Start the agent

```bash
npx balchemy start
```

You should see:

```
Starting Balchemy agent from: /path/to/agent.config.yaml
[agent] Running. Press Ctrl+C to stop.
[agent] status=running events=0 decisions=0 trades=0 llmCost=$0.0000/5
```

The agent:
1. Connects to the Balchemy SSE event stream
2. Receives market signals and platform events
3. Calls your LLM to decide whether to buy, sell, or hold
4. Executes approved trades via MCP tool calls
5. Can be monitored and adjusted through the Balchemy CLI cockpit (`npx balchemy`)

---

## Step 4: Docker (production)

```bash
npx balchemy docker
docker compose up -d
docker compose logs -f
```

The generated `docker-compose.yml` runs the agent with:
- `restart: always` — survives crashes and reboots
- Mounted `agent.config.yaml` — edit config without rebuilding
- JSON log rotation (10 MB × 5 files)

---

## Programmatic usage (TypeScript)

```typescript
import { AgentLoop } from '@balchemyai/agent-sdk';

// From YAML config file
const loop = AgentLoop.fromConfig('./agent.config.yaml');
await loop.start();

// Or inline config
const loop2 = new AgentLoop({
  mcpEndpoint: 'https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID',
  apiKey: process.env.BALCHEMY_API_KEY!,
  llmProvider: 'anthropic',
  llmApiKey: process.env.ANTHROPIC_API_KEY!,
  llmModel: 'claude-haiku-4-5',
  maxDailyLlmCost: 5,
  onStatusChange: (s) => console.log('status', s.status),
  onDecision: (d) => console.log('decision', d),
  onError: (e) => console.error('error', e.message),
});
await loop2.start();
```

---

## Strategy presets

| Preset | Description | Recommended model |
|--------|-------------|-------------------|
| `dca-accumulator` | Buy fixed-USD at regular intervals | gpt-4o-mini |
| `memecoin-sniper` | Buy on launch signals, sell on pump | claude-haiku-4-5 |
| `swing-trader` | Hold positions 2–72h, exit on RSI/MACD | claude-haiku-4-5 |
| `custom` | Define your own rules in `behavior_rules` | any |

See [BEHAVIOR_RULES.md](./BEHAVIOR_RULES.md) for the full rule schema.

---

## Next steps

- [BEHAVIOR_RULES.md](./BEHAVIOR_RULES.md) — customize your agent's trading logic
- [DEPLOYMENT.md](./DEPLOYMENT.md) — deploy to a VPS, Railway, or Render
- [examples/](./examples/) — ready-to-use strategy YAML files
