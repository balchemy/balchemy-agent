# Changelog

All notable changes to `@balchemyai/agent-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.2.10] — 2026-06-03

### Changed

- Stop the SDK agent loop from calling the hidden `agent_portfolio` MCP tool; it now uses the default-exposed `agent_status` surface for runtime context.
- Stop the CLI status refresh from polling hidden portfolio tools and clarify the README tool table to match `tools/list`.
- Keep CLI prompts aligned with advertised MCP tools so the external LLM does not invent hidden tool names.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.2.10` before `balchemy@0.2.10` so the CLI dependency resolves from npm semver.

## [0.2.9] — 2026-06-03

### Changed

- Correct CLI README provider documentation to match supported LLM providers.
- Clarify that saved agent credentials are encrypted locally while generated `.env` files remain plaintext local secret files.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.2.9` before `balchemy@0.2.9` so the CLI dependency resolves from npm semver.

## [0.2.8] — 2026-06-03

### Changed

- Sync the public SDK and CLI source with the latest monorepo onboarding, session, browser, and terminal UX updates.
- Harden SDK request, onboarding, telemetry, redaction, and public-boundary coverage for agent-facing clients.
- Refresh CLI setup guidance, config loading, OAuth/browser handling, and session synchronization behavior.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.2.8` before `balchemy@0.2.8` so the CLI dependency resolves from npm semver.

## [0.2.7] — 2026-05-29

### Added

- Add typed `agentMarketDiscovery()` SDK helper for the read-only broad market discovery MCP tool.
- Teach the CLI chat loop to follow backend `structured.suggestedTool` redirects from direct research to broad market discovery when the suggested tool is exposed.

### Notes

- Market discovery policy remains server-side in backend tools; the CLI only follows the backend MCP response contract.
- Publish `@balchemyai/agent-sdk@0.2.7` before `balchemy@0.2.7` so the CLI dependency resolves from npm semver.

## [0.2.6] — 2026-05-29

### Changed

- Align the public SDK and CLI release line after backend readiness healthcheck hardening.
- Keep the CLI dependency on the published SDK semver range for npm install compatibility.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.2.6` before `balchemy@0.2.6` so the CLI dependency resolves from npm semver.

## [0.2.5] — 2026-05-28

### Changed

- Align the public SDK and CLI release line with the backend MCP catalog, resource, and prompt hardening shipped after `0.2.4`.
- Document the stricter observability and telemetry privacy boundary for agent-facing MCP responses.
- Keep autonomous agent runtime expectations explicit: SDK/CLI clients remain API clients and execution still flows through scoped MCP credentials and server-side safety checks.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.2.5` before `balchemy@0.2.5` so the CLI dependency resolves from npm semver.

## [0.2.4] — 2026-05-24

### Changed

- Align SDK public package version with the `balchemy` CLI release line.
- Refresh public package metadata so npm repository links point to `github.com/balchemy/balchemy-agent`.
- Keep the SDK release available as the npm-compatible dependency target for `balchemy@0.2.4`.

### Notes

- Public CLI and SDK releases should stay version-aligned unless a release note explicitly says otherwise.
- CLI packages must depend on the published SDK with npm semver, not `workspace:` ranges.

## [0.1.0] — 2026-03-15

### Added

- `BalchemyAgentSdk` — main SDK class with SIWE and Identity onboarding flows
  - `requestSiweNonce()` — fetch SIWS nonce + message
  - `onboardWithSiwe()` — wallet-signed onboarding
  - `onboardWithIdentity()` — walletless provider-token onboarding
  - `revokeIdentityToken()` — revoke a provider token by JTI
  - `getIdentityTokenRevokeStatus()` — check revocation status
  - `connectMcp()` — instantiate a typed MCP client
- `BalchemyMcpClient` — JSON-RPC MCP client with automatic retry and SSE envelope parsing
  - Typed convenience methods: `askBot`, `tradeCommand`, `agentExecute`, `agentResearch`, `agentPortfolio`, `agentStatus`, `agentConfig`
  - EVM helpers: `evmQuote`, `evmSwap`
  - `requestSeed()` — disabled stub (throws `AgentSdkError` deterministically)
  - `listTools()`, `callTool()`, `ping()`
- `connectMcp()` — factory shortcut for `BalchemyMcpClient`
- `getToolText()`, `parseToolJson<T>()`, `isToolError()` — tool response helpers
- `SseEventStream` — async-iterable + callback-based SSE consumer with auto-reconnect
- `TokenStore` — token lifecycle manager with pluggable refresh callback
- `AgentSdkError` — typed error class with `code`, `status`, `message`, `details`
- Full TypeScript type exports:
  - `AgentSdkConfig`, `AgentOnboardingMode`, `AgentScope`
  - `IdentityAccess`, `OnboardingResponse`, `OnboardWithSiweInput`, `OnboardWithIdentityInput`
  - `SiweNonceResponse`, `RequestSiweNonceInput`
  - `RevokeIdentityTokenInput`, `IdentityTokenRevokeStatusInput`, `IdentityTokenRevokeResponse`
  - `McpTool`, `McpListToolsResponse`, `McpCallToolResponse`
  - `StoredToken`, `TokenRefreshFn`, `TokenStoreOptions`
  - `SseEvent`, `SseStreamOptions`
  - `AgentSdkErrorCode`
  - `AskBotArgs`, `TradeCommandArgs`, `AgentExecuteArgs`, `AgentResearchArgs`, `AgentConfigArgs`, `EvmQuoteArgs`, `EvmSwapArgs`
- `exports` field in `package.json` for ESM/CJS dual resolution and TypeScript `moduleResolution: bundler` compatibility
- Retry utility with configurable exponential backoff (`withRetry`, `RetryOptions`)

### Notes

- Default MCP endpoint exposes 7 tools; full 100-tool catalog requires `MCP_EXPOSE_GRANULAR_TOOLS=true` on the platform
- `agent_seed_request` is permanently disabled; `requestSeed()` always throws
- Minimum Node.js version: 18.0.0
