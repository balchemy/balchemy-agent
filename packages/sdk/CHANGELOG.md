# Changelog

All notable changes to `@balchemyai/agent-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.3.10] — 2026-06-30

### Changed

- Prepare the SDK and CLI package line for the next coordinated patch release.
- Align package examples and docs with default MCP exposure, safe read wrappers,
  Hub Access, walletless setup, and live-armed fail-closed boundaries.
- Remove the CLI automatic npm registry update check from launch paths and stop
  package docs/templates from suggesting global installs.
- Build CLI package output from a production `tsconfig` so package dist does not
  include compiled test artifacts.

### Notes

- This is a release-prep source entry only. npm publish, public mirror sync, and
  live package install proof remain separate release steps.
- No live-trade proof, Base live coverage, or source-owner payout rails are
  claimed by this package release.
- Publish `@balchemyai/agent-sdk@0.3.10` before `balchemy@0.3.10` so the CLI
  dependency resolves from npm semver.

## [0.3.7] — 2026-06-08

### Fixed

- Keep the public CLI bin executable after local and release builds so `balchemy`
  and `npx balchemy` do not fail with `Permission denied`.

### Notes

- SDK API surface is unchanged; this release keeps SDK and CLI package versions
  aligned for public npm consumers.
- No wallet keys, trading internals, or backend policy logic are shipped in the
  public packages.
- Publish `@balchemyai/agent-sdk@0.3.7` before `balchemy@0.3.7` so the CLI
  dependency resolves from npm semver.

## [0.3.6] — 2026-06-05

### Fixed

- Keep the CLI cockpit on one input owner so terminal text is not mirrored into a second shell prompt.
- Harden prompt editing after cursor movement: Backspace/Delete, paste normalization, erase-left, word navigation, and long-input cursor viewport are covered by regression tests.
- Add activity transcript paging and borderless focus/export behavior so copying history does not include TUI chrome.
- Reduce repeated rate-limit pressure in the SDK loop by briefly caching empty runtime/rules snapshots after backend fetch failures.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.3.6` before `balchemy@0.3.6` so the CLI dependency resolves from npm semver.

## [0.3.5] — 2026-06-04

### Fixed

- Fail closed in the CLI cockpit before `trade_command` when action, chain, token, or amount is missing, random, or unknown.
- Require an exact trade confirmation phrase instead of a bare `TRADE` confirmation.
- Label side-less confirmed trade messages as `TRADE` instead of defaulting to `SELL`.
- Clarify runtime pause/resume/arm/disarm routing so chat does not answer mutation requests with read-only snapshots.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.3.5` before `balchemy@0.3.5` so the CLI dependency resolves from npm semver.

## [0.3.4] — 2026-06-04

### Fixed

- Replace fragile prompt editing state with a tested editor reducer so Backspace, Delete, arrow navigation, Ctrl+A, and Ctrl+E work before raw terminal control-byte filtering.
- Use terminal alternate-screen mode for the live cockpit so shell prompt artifacts do not appear as a second input area under the TUI.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.3.4` before `balchemy@0.3.4` so the CLI dependency resolves from npm semver.

## [0.3.3] — 2026-06-04

### Fixed

- Harden the CLI cockpit setup state machine so read-only runtime/market/risk prompts do not get consumed by onboarding.
- Block trade, wallet, approval, and runtime-control mutation prompts while setup is incomplete instead of routing them through setup or tool execution.
- Avoid repeated setup-scope-required notices after an MCP key lacks setup/manage scope.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.3.3` before `balchemy@0.3.3` so the CLI dependency resolves from npm semver.

## [0.3.2] — 2026-06-03

### Fixed

- Let read-only runtime, rules, context, portfolio, market, and risk prompts bypass the in-chat setup wizard when setup is incomplete.
- Stop setup prompts after setup/manage-scope failures instead of looping on the same wallet confirmation question.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.3.2` before `balchemy@0.3.2` so the CLI dependency resolves from npm semver.

## [0.3.1] — 2026-06-03

### Changed

- Keep safe read wrapper tools visible for agents with stale MCP allowlists while raw/internal agent tools remain hidden.
- Improve CLI cockpit input handling for PageUp/PageDown, arrow navigation, long prompts, and visible cursor placement.
- Add a redacted plain-text activity transcript export from the cockpit.
- Prefer safe context, market brief, candidate, and risk tools in CLI chat prompts when the backend advertises them.
- Stop vague retry suggestions when market or risk data is unavailable, degraded, rate limited, or unsupported.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.3.1` before `balchemy@0.3.1` so the CLI dependency resolves from npm semver.

## [0.3.0] — 2026-06-03

### Changed

- Align the SDK and CLI with the autonomous dual-LLM runtime contract.
- Add safe runtime/read surfaces for context snapshots, market briefs, candidate reports, risk reports, and backend runtime control.
- Keep raw/internal research, discovery, and portfolio tools hidden from public MCP routing.
- Require a fresh backend `live_armed` runtime state before SDK/local runners can send `trade_command`.
- Redact autonomous control and prompt-like inputs from public audit summaries.

### Notes

- No wallet keys, trading internals, or backend policy logic are shipped in the public packages.
- Publish `@balchemyai/agent-sdk@0.3.0` before `balchemy@0.3.0` so the CLI dependency resolves from npm semver.

## [0.2.10] — 2026-06-03

### Changed

- Stop the SDK agent loop from calling the hidden `agent_portfolio` MCP tool; it now uses the default-exposed `agent_status` surface for runtime context.
- Gate SDK `trade_command` calls on a fresh backend `autonomous_runtime` state; local `shadowMode=false` no longer bypasses `live_armed`/paused control.
- Stop the CLI status refresh from polling hidden portfolio tools and clarify the README tool table to match `tools/list`.
- Add CLI runtime control commands for backend status, pause, resume, arm, and disarm.
- Keep CLI prompts aligned with advertised MCP tools so the external LLM does not invent hidden tool names.
- Clarify backend setup guidance so external agents do not call hidden portfolio tools directly.

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
  - Historical early typed helpers were narrowed in later releases. Current
    public convenience methods are the safe helper surface: `askBot`,
    `agentStatus`, `agentReadinessReport`, `agentContextSnapshot`,
    `agentMarketBrief`, `agentCandidateReport`, and `agentRiskReport`.
  - Direct quote, swap, wallet mutation, and privileged instruction helpers are
    not exposed as typed public SDK methods. Use `tools/list` and `callTool()`
    for the current scoped MCP surface.
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

- Default MCP endpoint exposes high-level agent tools; `MCP_EXPOSE_GRANULAR_TOOLS=true` adds the explicit read-only, non-raw granular Web3 research allowlist for scope-qualified agents.
- `agent_seed_request` is permanently disabled; `requestSeed()` always throws
- Minimum Node.js version: 18.0.0
