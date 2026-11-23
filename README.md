<h1 align="center">
  <img src="https://www.balchemy.ai/images/balchemy-logo.svg" alt="Balchemy" width="240" />
</h1>

<p align="center">
  <strong>Balchemy CLI and SDK</strong><br/>
  Public source of the <code>balchemy</code> CLI and <code>@balchemyai/agent-sdk</code>.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/balchemy"><img src="https://img.shields.io/npm/v/balchemy?color=blue&label=balchemy%20CLI" alt="balchemy npm version" /></a>
  <a href="https://www.npmjs.com/package/@balchemyai/agent-sdk"><img src="https://img.shields.io/npm/v/@balchemyai/agent-sdk?color=blue&label=agent-sdk" alt="SDK npm version" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js >=20" />
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" />
</p>

---

## Packages

| Package | Version | Purpose |
| --- | --- | --- |
| [`balchemy`](packages/cli) | `0.9.0` | Terminal chat cockpit and local runner for a Balchemy trading agent on Solana |
| [`@balchemyai/agent-sdk`](packages/sdk) | `0.9.0` | Signed runner protocol clients and local LLM adapters used by the CLI runner |

The CLI and SDK ship together at the same version. `balchemy@0.9.0` pairs with
`@balchemyai/agent-sdk@0.9.0` and `@balchemyai/agent-rules@1.2.0` (installed
from npm).

## Quick start

```bash
npx balchemy
```

It needs Node.js 20 or newer on macOS or Linux with glibc. See
[`packages/cli/README.md`](packages/cli/README.md) for first-run setup, the
safety model and the cockpit commands, and
[`packages/sdk/README.md`](packages/sdk/README.md) for the SDK clients.

## Changes in 0.9.0

The MCP client, the ERC-8004 onboarding flow, the token store, SSE streaming
and the external agent loop were removed from the SDK in `0.9.0`. See
[`packages/sdk/CHANGELOG.md`](packages/sdk/CHANGELOG.md) and
[`packages/cli/CHANGELOG.md`](packages/cli/CHANGELOG.md).

## Repository layout

```text
packages/cli      balchemy npm package
packages/sdk      @balchemyai/agent-sdk npm package
```

This repository holds the package sources and docs only. The Balchemy backend
and trading engine are not part of it.

## Links

- Platform: [balchemy.ai](https://balchemy.ai)
- Documentation: [balchemy.ai/hub/docs](https://balchemy.ai/hub/docs)
- npm: [balchemy](https://www.npmjs.com/package/balchemy) · [@balchemyai/agent-sdk](https://www.npmjs.com/package/@balchemyai/agent-sdk)
- X: [@balchemyai](https://x.com/balchemyai)

## License

MIT
