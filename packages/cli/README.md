<h1 align="center">
  <img src="https://www.balchemy.ai/images/balchemy-logo.svg" alt="Balchemy" width="240" />
</h1>

<p align="center">
  <strong>Balchemy CLI</strong><br/>
Set up and manage private local agents, connect your model, and review rules and research.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/v/balchemy?color=blue&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/dt/balchemy?color=green" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="node version" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="license" />
  <a href="https://balchemy.ai"><img src="https://img.shields.io/badge/platform-live-balchemy.ai-purple" alt="platform" /></a>
</p>

---

## Quick start

```bash
npx balchemy
```

You can also install it globally and run `balchemy`. It needs Node.js 20 or
newer on macOS or Linux with glibc. Windows and Alpine/musl are not supported
yet (`balchemy doctor` checks your setup).

Version `0.9.0` pairs with `@balchemyai/agent-sdk@0.9.0` and
`@balchemyai/agent-rules@1.2.0`.

## What happens on first run

`balchemy` opens a chat cockpit in your terminal. The local runner starts by
itself in shadow mode, so nothing can trade until you arm it. Setup goes in this
order:

1. Name the agent (`main` by default).
2. AI model: choose OpenAI, Anthropic or OpenRouter, paste your own API key
   (hidden, checked at once), then pick a model.
3. Daily AI budget in US dollars ($5 by default). It caps the agent's own AI
   API cost per UTC day.
4. Trading wallet: create or import a local Solana wallet for the agent.
5. One Hub visit: sign in, link the runner to your Hub account and sign your SOL
   spend ceiling in the browser.
6. Chat and the setup card (Ctrl+E): strategy and rules (a stop-loss is
   required), signal sources, spend limits, buy size and funding, then one typed
   confirmation of the whole summary.
7. Arming is a separate step with its own review, a typed `ARM <agent>` and
   your passphrase.

## Safety model

- Your model key and the trading wallet's private key stay on your computer,
  encrypted with your passphrase. A chat message that looks like a key or seed
  phrase is stopped before it reaches the model (best effort: never paste
  secrets into chat).
- Balchemy builds unsigned swaps. The runner validates and simulates them, then
  signs locally.
- Deterministic checks gate every buy: your confirmed rules, your spend limits
  and your signed spend ceiling. The AI model reads and proposes; it cannot
  save, confirm or arm anything.
- `/pause` stops new buys but leaves an armed agent armed, so stop-loss and
  take-profit exits keep running. `/stop` stops everything, exits included.
- Lowering risk acts at once. Raising it (a higher budget or limit, `/arm`,
  rule changes) opens a card with its own typed confirmation.

## Cockpit commands

Type them in the input line. Text in a model reply or a feed line is never a
command.

| Command | What it does |
|---|---|
| `/agents`, `/new` | List and switch agents (Ctrl+N); add and set up a new one |
| `/pause`, `/resume`, `/stop` | Stop new buys; turn them back on or return to shadow mode; stop the agent |
| `/arm` | Open the arm card (checks, `ARM <agent>`, passphrase) |
| `/directive [change]` | Show the strategy or open the rules card |
| `/limit`, `/budget` | Show or set SOL spend limits and the daily AI budget |
| `/model`, `/signals`, `/lang` | AI model, launchpad signal sources, reply language |
| `/status`, `/positions`, `/wallet` | State, open positions with realized PnL in SOL, wallet address and balance |
| `/settings`, `/help`, `/exit` | Settings (Ctrl+S), commands and shortcuts (`?`), leave |

Ctrl+E opens the current card. Ctrl+Q leaves the cockpit and the runner keeps
running; run `balchemy` again to continue. `/ask`, `/buy` and `/sell` are listed
but arrive in a later update.

## Runner commands

`balchemy runner --help` lists them all. The common ones:

```bash
balchemy runner status [id]           # Runner, version, Hub connection, agents
balchemy runner start [id ...]        # Start in shadow mode; bare start resumes known agents
balchemy runner stop <id>             # Stop one agent
balchemy runner shutdown              # Stop the runner and every agent
balchemy runner wallet <id> lock      # Also: create | import | unlock | status | limits
balchemy runner rpc <id> set          # Your own Solana RPC (advanced)
balchemy runner arm <id>              # Arm live trading from the CLI
balchemy runner disarm <id>           # Disarm immediately
balchemy runner trades <id>           # Local signed-trade journal (read-only)
balchemy runner positions <id>        # Local positions (read-only)
balchemy doctor --runner              # Read-only runner health check
```

## Platform limits

- The runner does not start again after a reboot, and it does nothing while the
  computer sleeps. Run `balchemy runner start` after a restart.
- A running runner keeps the version it started with. After an upgrade run
  `balchemy runner shutdown`, then `balchemy runner start`. A restart locks the
  trading wallet and disarms the agent; unlock the wallet again afterwards.
- Stop-loss and take-profit exits run only while the computer is on, the runner
  is running and the wallet is unlocked.
- The runner keeps no log file in this version. Use `runner status`,
  `runner trades`, `runner positions` and `doctor --runner`.

## Removed commands

Version 0.9.0 removed the earlier external MCP connection model and its
commands: `legacy`, `start`, `tui`, `list`, `control`, `agent`, `auth`,
`config`, `context` and `docker`. They now print a short notice and exit; run
`balchemy` instead. The CLI no longer reads `agent.config.yaml` or the old
`~/.balchemy/agents.enc` credential file, and it does not delete that file. The
cockpit and the runner commands above are the only way to run an agent.

## Links

- [Platform](https://balchemy.ai)
- [Documentation](https://balchemy.ai/hub/docs)
- [GitHub](https://github.com/balchemy/balchemy-agent)
- [npm: balchemy](https://www.npmjs.com/package/balchemy)
- [X: @balchemyai](https://x.com/balchemyai)

## License

MIT
