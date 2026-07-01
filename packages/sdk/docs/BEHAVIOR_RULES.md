# Behavior Rules (BRL) — YAML Reference

Behavior rules define how your agent trades. They are validated by the Balchemy
backend before any trade is executed. The agent's LLM reads a compressed summary
of your rules as context for every decision.

---

## Where to set rules

**In `agent.config.yaml`** (inline):

```yaml
behavior_rules:
  version: "1"
  preset: custom
  risk:
    max_single_trade_usd: 50
```

**As a separate file** (referenced by path):

```yaml
behavior_rules_path: ./my-rules.yaml
```

---

## Schema

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `version` | string | Yes | Rule schema version. Always `"1"`. |
| `preset` | string | No | Base preset to inherit (`memecoin-sniper`, `dca-accumulator`, `swing-trader`, `custom`). Inline fields override preset defaults. |

---

### `risk` — global safety limits

```yaml
risk:
  max_single_trade_usd: 50       # Hard cap per trade. Default: 50
  max_daily_loss_usd: 200        # Pause trading after this daily loss. Default: 500
  max_open_positions: 5          # Max simultaneous positions. Default: 10
  pause_on_drawdown_pct: 20      # Pause if portfolio drops this % from peak. Default: none
  allowed_chains: [solana]       # Restrict to specific chains. Default: [solana, base]
```

---

### `filters` — asset eligibility

```yaml
filters:
  min_liquidity_usd: 10000       # Reject tokens below this liquidity. Default: 5000
  max_market_cap_usd: 10000000   # Reject tokens above this market cap. Default: none
  require_verified_contract: false  # Only trade verified contracts. Default: false
  blocked_tokens:                # Token addresses to never trade
    - "So11111111111111111111111111111111111111112"
  allowed_tokens:                # Allowlist (if set, only these tokens trade)
    - "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
```

---

### `entry` — trade entry conditions

```yaml
entry:
  trigger: launch_signal         # launch_signal | price_drop | rsi_signal | manual
  max_position_usd: 100          # Max USD per position. Default: 50
  slippage_bps: 200              # Max slippage in basis points. Default: 100
  min_confidence: 0.7            # Min LLM confidence score to enter. Default: 0.5
  indicators: [rsi, macd]        # Required indicators for entry. Default: []
  rsi_oversold: 30               # Enter when RSI below this value. Default: 30
```

---

### `exit` — trade exit conditions

```yaml
exit:
  take_profit_pct: 50            # Close position when up this %. Default: none
  stop_loss_pct: 25              # Close position when down this %. Default: none
  trailing_stop_pct: 10          # Trailing stop loss. Default: none
  max_hold_minutes: 120          # Force exit after this many minutes. Default: none
  min_hold_hours: 1              # Do not exit before this time. Default: 0
  max_hold_hours: 72             # Force exit after this time. Default: none
```

---

### `dca` — dollar-cost averaging (DCA preset)

```yaml
dca:
  target_token: SOL              # Token to accumulate
  amount_usd: 10                 # USD per interval purchase
  interval_hours: 24             # Purchase interval in hours
  max_total_usd: 1000            # Stop after this total invested. Default: none
```

---

## Preset defaults

### memecoin-sniper

```yaml
behavior_rules:
  version: "1"
  preset: memecoin-sniper
  filters:
    min_liquidity_usd: 10000
    max_market_cap_usd: 5000000
    require_verified_contract: false
  entry:
    trigger: launch_signal
    max_position_usd: 50
    slippage_bps: 300
  exit:
    take_profit_pct: 100
    stop_loss_pct: 50
    max_hold_minutes: 60
```

### dca-accumulator

```yaml
behavior_rules:
  version: "1"
  preset: dca-accumulator
  dca:
    target_token: SOL
    amount_usd: 10
    interval_hours: 24
    max_total_usd: 1000
  risk:
    max_single_trade_usd: 10
    pause_on_drawdown_pct: 30
```

### swing-trader

```yaml
behavior_rules:
  version: "1"
  preset: swing-trader
  entry:
    indicators: [rsi, macd]
    rsi_oversold: 30
    max_position_usd: 200
    slippage_bps: 100
  exit:
    take_profit_pct: 20
    stop_loss_pct: 10
    min_hold_hours: 2
    max_hold_hours: 72
```

---

## Enforcement

Rules are enforced at three levels:

1. **Pre-check** — asset filters applied before the LLM is called (no LLM cost)
2. **LLM context** — compressed rule summary injected into every decision prompt
3. **Post-check** — Balchemy backend validates trade parameters against rules before execution

If a trade violates a rule at any level, it is rejected with an error logged via `onError`.

---

## Tips

- Start with a preset and override only the fields you need
- Keep `max_single_trade_usd` low (≤ $50) until you trust your strategy
- Use `blocked_tokens` to exclude known scams
- Use `min_confidence` to reduce false positives when LLM is uncertain
- Monitor LLM cost with `onStatusChange` — `llmCostToday` / `maxDailyLlmCost`
