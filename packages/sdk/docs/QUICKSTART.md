# Balchemy Agent — Quickstart

Connect a local CLI/SDK runner to a Balchemy Hub agent in under 5 minutes.

---

## Prerequisites

- Node.js 18+ (or Docker)
- A Balchemy account with at least one Hub agent, or an explicit walletless
  onboarding flow
- A scoped MCP/API key from Hub > Agents > your agent > Access/API Keys
- An LLM API key (Anthropic or OpenAI)

---

## Step 1: Create or select a Hub agent

1. Go to [balchemy.ai](https://balchemy.ai) and sign in
2. Open Hub > Agents > New Agent
3. Complete the setup wizard enough to create the agent and runtime state
4. Open the agent Access/API key flow
5. Copy the MCP endpoint: `https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID`
6. Generate a scoped API key and copy it (shown once)

---

## Step 2: Run the setup wizard

```bash
npx balchemy
```

The wizard asks:
- LLM provider, API key, and model
- New walletless agent or existing MCP endpoint/API key
- Strategy preset and natural-language behavior rules
- Whether to open the local cockpit

New walletless agents are provisioned first. Root/recovery wallet binding and
chain-specific setup happen later through the authenticated MCP setup flow.
Existing agents can be resumed from the encrypted local agent store.

---

## Step 3: Start the local runner

```bash
npx balchemy start
```

The agent:
1. Connects to the Balchemy SSE event stream
2. Receives market signals and platform events
3. Fetches fresh `agent_status` and behavior rules before asking your LLM to
   decide whether to buy, sell, hold, block, or mark data degraded
4. Blocks trade calls in `shadow`, `live_unarmed`, `paused`, stale status, or
   missing-rule states
5. Calls `trade_command` only when local live mode and backend runtime are both
   live-armed and the policy/approval path allows it
6. Can be monitored and adjusted through the Balchemy CLI cockpit (`npx balchemy`)

`shadow_mode` remains the safe default. Setting local `shadow_mode: false` is
not enough to trade; the backend must report `autonomous_runtime.mode` as
`live_armed`, `armed=true`, and `paused=false`.

This quickstart does not claim live-trade proof, Base live coverage, or
source-owner payout rails. Verify those from current runtime/backend evidence
before relying on them.

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

const statusEvents: string[] = [];
const decisionEvents: unknown[] = [];
const errorEvents: string[] = [];

const loop2 = new AgentLoop({
  mcpEndpoint: 'https://api.balchemy.ai/mcp/YOUR_PUBLIC_ID',
  apiKey: process.env.BALCHEMY_API_KEY!,
  llmProvider: 'anthropic',
  llmApiKey: process.env.ANTHROPIC_API_KEY!,
  llmModel: 'claude-haiku-4-5',
  maxDailyLlmCost: 5,
  onStatusChange: (s) => statusEvents.push(s.status),
  onDecision: (d) => decisionEvents.push(d),
  onError: (e) => errorEvents.push(e.message),
});
await loop2.start();
```

The SDK constructs `AgentLoop` from explicit config. Use `npx balchemy start`
when you want the CLI to load `agent.config.yaml` for you.

For read-first integrations, use `connectMcp()`/`listTools()` and call only the
runtime-advertised tools. Safe read wrappers include `agent_status`,
`agent_context_snapshot`, `agent_market_brief`, `agent_candidate_report`, and
`agent_risk_report`. Raw provider, approval, withdrawal, swap-bypass, and
privileged manage surfaces are not public SDK helpers.

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
