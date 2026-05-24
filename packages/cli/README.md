<h1 align="center">
  <img src="https://www.balchemy.ai/images/balchemy-logo.svg" alt="Balchemy" width="240" />
</h1>

<p align="center">
  <strong>Balchemy CLI</strong><br/>
  A terminal-first setup wizard and TUI cockpit for autonomous Balchemy agents.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/v/balchemy?color=blue&label=npm" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/dt/balchemy?color=green" alt="npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js >=18" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
</p>

---

## Install

```bash
npx balchemy@latest
```

Or install globally:

```bash
npm install -g balchemy@latest
balchemy --help
```

## What The CLI Does

The CLI creates and runs local Balchemy agent workspaces. It helps you:

- choose an LLM provider;
- store local runtime credentials safely;
- generate `agent.config.yaml` and `.env`;
- start the Ink-based terminal cockpit;
- preview Docker deployment files before writing;
- inspect local agent context in human or JSON output;
- confirm risky trade paths with explicit terminal context.

Balchemy execution still happens through scoped MCP credentials and platform risk checks. The CLI does not ship backend trading internals, private endpoints, or wallet key material.

## Command Guide

```bash
balchemy                         # Setup wizard or resume cached agent
balchemy init                    # Force a new setup wizard
balchemy auth login              # Alias for interactive setup
balchemy auth status             # Show local auth/context status
balchemy auth logout --force     # Clear active local context

balchemy start [config]          # Start the TUI cockpit
balchemy tui [config]            # Alias for start

balchemy agent list              # List saved agents
balchemy agent current           # Show active saved agent
balchemy context current         # Alias for agent current
balchemy agent use <publicId>    # Switch active saved agent

balchemy config validate [file]  # Validate config and env references
balchemy config list             # Print config summary
balchemy doctor                  # Environment and package diagnostics

balchemy docker [outDir]         # Generate Dockerfile, compose, and env example
balchemy docker --dry-run        # Preview generated files without writing

balchemy --help                  # Usage
balchemy --version               # Version
```

## Global Flags

| Flag | Purpose |
| --- | --- |
| `--json` | Stable machine-readable output for non-interactive commands |
| `--quiet`, `-q` | Suppress non-essential human output |
| `--verbose` | Show extra context for diagnostics |
| `--debug` | Include debug details in human errors |
| `--ci` | Fail closed instead of opening prompts/TUI |
| `--dry-run` | Preview actions without writing files |
| `--yes`, `-y` | Approve safe non-interactive prompts where supported |
| `--force` | Required for explicit destructive local actions |
| `--no-color` | Disable ANSI color output |

`NO_COLOR=1` and `TERM=dumb` are also respected.

## Scriptable Output

Use JSON mode for automation:

```bash
balchemy agent list --json
balchemy agent current --json
balchemy config validate --json --ci
balchemy doctor --json
balchemy docker --dry-run --json
```

JSON output uses a stable top-level envelope:

```json
{
  "ok": true,
  "command": "doctor",
  "version": "0.2.4",
  "data": {},
  "warnings": [],
  "error": null
}
```

Secrets and token-looking values are redacted before output.

## TUI Cockpit

The TUI is for interactive agent operation, not CI scripts. It shows agent context, chat, tool activity, settings, and trade confirmation panels.

| Shortcut | Action |
| --- | --- |
| `Ctrl+S` | Open settings |
| `?` | Open keyboard help |
| `Ctrl+L` | Clear visible chat activity |
| `Ctrl+N` | Return to launcher |
| `Ctrl+Q` | Quit |
| `PgUp/PgDn` | Scroll activity history |
| `Esc` | Go back or cancel a trade prompt |

Live trade prompts require typing `TRADE`. Anything else cancels.

## Files Written

The wizard writes local files in the current working directory:

```text
agent.config.yaml
.env
.gitignore
```

Before writing, the wizard previews whether each file will be created, appended, skipped, or overwritten. `.env` contains local secrets and should never be committed.

## Docker Generation

```bash
balchemy docker ./deploy --dry-run
balchemy docker ./deploy --force
```

The generator can create:

```text
Dockerfile
docker-compose.yml
.env.example
```

It blocks overwrites unless you explicitly review and approve them.

## Safety Notes

- External LLMs never receive raw wallet or private-key access through this CLI.
- MCP keys are scoped and revocable.
- Behavior rules remain part of the execution contract.
- Pre-trade checks and server-side policy are the authority for execution.
- Never paste private keys, seed phrases, production credentials, or DSNs into prompts or logs.

## Development

```bash
pnpm --dir packages/sdk run typecheck
pnpm --dir packages/sdk run build
pnpm --dir packages/cli run typecheck
pnpm --dir packages/cli run build
pnpm --dir packages/cli pack --dry-run
```

Release packages together when public behavior spans both SDK and CLI. Replace workspace dependencies with npm semver before publishing.

## Links

- Platform: [balchemy.ai](https://balchemy.ai)
- Documentation: [balchemy.ai/hub/docs](https://balchemy.ai/hub/docs)
- GitHub: [github.com/balchemy/balchemy-agent](https://github.com/balchemy/balchemy-agent)
- npm: [balchemy](https://www.npmjs.com/package/balchemy)
- SDK: [@balchemyai/agent-sdk](https://www.npmjs.com/package/@balchemyai/agent-sdk)

## License

MIT
