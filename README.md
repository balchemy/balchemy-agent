<h1 align="center">
  <img src="https://www.balchemy.ai/images/balchemy-logo.svg" alt="Balchemy" width="240" />
</h1>

<p align="center">
  <strong>Autonomous AI Trading Agent Platform</strong><br/>
  Public SDK and CLI for connecting external LLM agents to Balchemy MCP execution.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/v/balchemy?color=blue&label=balchemy%20CLI" alt="balchemy npm version" /></a>
  <a href="https://www.npmjs.com/package/@balchemyai/agent-sdk"><img src="https://img.shields.io/npm/v/@balchemyai/agent-sdk?color=blue&label=agent-sdk" alt="SDK npm version" /></a>
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/dt/balchemy?color=green" alt="balchemy npm downloads" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node.js >=18" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
  <a href="https://balchemy.ai"><img src="https://img.shields.io/badge/platform-balchemy.ai-purple" alt="Balchemy platform" /></a>
</p>

---

## Packages

| Package | Latest | Purpose |
| --- | --- | --- |
| [`balchemy`](packages/cli) | [npm](https://www.npmjs.com/package/balchemy) | CLI wizard, terminal cockpit, local config, Docker deployment templates |
| [`@balchemyai/agent-sdk`](packages/sdk) | [npm](https://www.npmjs.com/package/@balchemyai/agent-sdk) | TypeScript SDK for onboarding, MCP calls, SSE streams, and long-running agent loops |

The CLI and SDK are released together. Keep their public versions aligned unless a release note explicitly says otherwise.

## Quick Start

```bash
npx balchemy@latest
```

Common commands:

```bash
npx balchemy init                 # Start the setup wizard
npx balchemy start                # Run the TUI from agent.config.yaml
npx balchemy agent list --json    # Scriptable saved-agent list
npx balchemy agent current        # Show active local context
npx balchemy control status       # Show backend autonomous runtime mode
npx balchemy control pause        # Pause backend autonomy
npx balchemy control resume       # Resume backend autonomy
npx balchemy control arm          # Arm live execution after policy gates
npx balchemy control disarm       # Disarm live execution
npx balchemy config validate      # Validate local config and env references
npx balchemy docker --dry-run     # Preview Docker files before writing
npx balchemy doctor --json        # Machine-readable environment checks
```

The terminal flow is designed for safe local setup: preview generated files, keep secrets out of output, and require explicit confirmation for risky execution paths.

## What Balchemy Does

Balchemy connects an external LLM to on-chain markets through the Model Context Protocol. The external LLM chooses tools and strategy. Balchemy applies scoped credentials, behavior rules, risk checks, execution, verification, and records.

```text
Strategy -> external LLM -> Balchemy MCP -> policy/risk -> execution -> record
                                  |
                                  v
                         inner LLM support
```

The inner LLM is infrastructure support for data fetching and response formatting. It does not make autonomous trading decisions.

## CLI Highlights

- Interactive setup wizard for model provider, local config, and strategy rules.
- TUI cockpit for agent chat, tool activity, settings, and trade confirmation.
- Structured command architecture for humans and automation.
- `--json`, `--quiet`, `--verbose`, `--debug`, `--ci`, `--dry-run`, `--yes`, and `--force` where applicable.
- Secret redaction in terminal and JSON output.
- Dry-run and overwrite guards for generated deployment files.
- Typed trade confirmation before live execution.
- `NO_COLOR=1`, `TERM=dumb`, and non-TTY behavior for CI-safe terminals.

See [`packages/cli/README.md`](packages/cli/README.md) for the full command guide.

## SDK Highlights

- `BalchemyAgentSdk` for SIWE and identity-provider onboarding.
- Typed MCP client for agent-facing tools.
- `AgentLoop` for SSE-backed long-running autonomous agents.
- Retry, error, token-store, and streaming utilities.
- TypeScript declarations shipped in the npm package.

See [`packages/sdk/README.md`](packages/sdk/README.md) and [`packages/sdk/docs/QUICKSTART.md`](packages/sdk/docs/QUICKSTART.md).

## Agent-Facing MCP Tools

The runtime `tools/list` response is the source of truth for the current agent's
MCP surface. Availability depends on key scope and backend policy.

Typical capabilities include chat/research, runtime status, walletless setup,
safe context snapshots, safe market briefs, candidate and risk reports,
behavior-rule management, subscriptions, runtime control, and approved trade
commands. Raw direct research, broad discovery, and portfolio snapshots stay
behind the platform boundary unless they are explicitly returned by `tools/list`.

The public SDK and CLI do not contain backend trading internals, private
endpoints, privileged workflows, or secrets.

## Safety Model

Every trade path is expected to preserve this shape:

```text
Intent -> Plan -> Policy -> Execute -> Verify -> Notify
```

Safety defaults:

- External LLMs never receive raw wallet or private-key access.
- MCP keys are scoped and revocable.
- Behavior rules constrain execution.
- Pre-trade checks run before approved execution.
- CLI trade prompts show agent, host, chain, token, amount, and execution mode before approval.
- Secrets belong in local `.env` or platform-managed vaults, never in source, logs, prompts, screenshots, npm packages, or generated reports.

## LLM Providers

| Provider | Environment variable |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| xAI Grok | `GROK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

## Repository Layout

```text
packages/cli      balchemy npm package
packages/sdk      @balchemyai/agent-sdk npm package
```

Release checklist:

1. Keep CLI and SDK versions aligned for public releases.
2. Replace workspace dependencies with npm-compatible semver before publishing.
3. Build and pack both packages before publish.
4. Publish SDK first when CLI depends on the new SDK version.
5. Commit source, docs, package metadata, lockfile, and tags in the public repo after npm publish.
6. Push `main` and release tags so npm's repository links match the published code.

## Links

- Platform: [balchemy.ai](https://balchemy.ai)
- Documentation: [balchemy.ai/hub/docs](https://balchemy.ai/hub/docs)
- Agent Explorer: [balchemy.ai/explorer](https://balchemy.ai/explorer)
- GitHub: [github.com/balchemy/balchemy-agent](https://github.com/balchemy/balchemy-agent)
- npm: [balchemy](https://www.npmjs.com/package/balchemy) · [@balchemyai/agent-sdk](https://www.npmjs.com/package/@balchemyai/agent-sdk)
- X: [@balchemyai](https://x.com/balchemyai)
- Contact: [burak@balchemy.ai](mailto:burak@balchemy.ai)

## License

MIT
