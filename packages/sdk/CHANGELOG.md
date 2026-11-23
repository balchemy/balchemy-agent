# Changelog

All notable changes to `@balchemyai/agent-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.9.0] — 2026-11-XX

### Removed (breaking)

- The external MCP client: `BalchemyMcpClient`, `connectMcp`, `getToolText`, `parseToolJson`, `isToolError`, the `agent*Report` helpers and every `Mcp*` type. External MCP is retired; the CLI runner plus Hub is the only product path.
- ERC-8004 onboarding and identity tokens: `BalchemyAgentSdk` / `BalchemyClient`, `TokenStore`, and the SIWE and walletless onboarding types (`OnboardWith*`, `RevokeIdentityToken*`, `SiweNonceResponse`, `AgentSdkConfig`, `AgentScope`, `IdentityAccess`).
- `SseEventStream` and the external `AgentLoop` with its types (`AgentLoopConfig`, `AgentEvent`, `AgentDecision`, `AgentStatus`, `AgentLoopStatus`) and internals (decision handler, webhook receiver, model router, LLM cost tracker, rule checker, telemetry reporter).
- The MCP and onboarding examples, and the QUICKSTART, DEPLOYMENT, BEHAVIOR_RULES, partner-checklist and Python-parity docs that described them.

### Kept

- `AgentSdkError` and `AgentSdkErrorCode`, every `Runner*` client and validator, `createLocalLlmAdapter`, `isLlmModelId` and the `Llm*` types.

Older package versions are not deprecated. The CLI no longer reads `~/.balchemy/agents.enc`; the file is left untouched.

## [0.8.1] — 2026-11-22

### Added

- `LlmRequestOptions.jsonObject` (optional, opt-in): asks for one JSON object as the reply. The OpenAI adapter then sends `response_format: { type: "json_object" }`, but only to the official OpenAI endpoint (`https://api.openai.com/v1`). Other OpenAI-protocol endpoints (OpenRouter, self-hosted) and the Anthropic adapter ignore it, so a provider that rejects the field never receives it. It is a hint, not a guarantee: callers still validate the text, and the messages must mention JSON (OpenAI refuses JSON mode otherwise). Without the option the request body is unchanged.

## [0.8.0] — 2026-11-22

### Added

- Launchpad signal sources (K4): `fetchRunnerLaunchpadCatalog` / `validateRunnerLaunchpadCatalog` (public GET `/api/nest/local-agents/launchpads`, closed version 1), and `RunnerLaunchpadSubscriptionsClient` (runner-signed `get` / `set` over POST `/api/nest/local-agents/launchpad-subscriptions/{nonce,query}`, ids strictly ascending, at most 32; a refused id raises an `AgentSdkError` whose machineCode is `LAUNCHPAD_UNKNOWN` or `LAUNCHPAD_NOT_LIVE` (the lower-case ids stay in `details.reason`)). Also `canonicalRunnerLaunchpadIds`, `runnerLaunchpadSubscriptionsRequestDigest` and the nonce helpers.
- Signal platform `launchpad` (`RUNNER_SIGNAL_PLATFORMS`). A poll row of a platform this SDK does not know, with a valid digest and scope, no longer invalidates the whole page: it is returned in `result.ignored` (event id and digest only) so the runner can ACK it without acting.

- `RunnerRpcAccessClient` (POST `/api/nest/local-agents/rpc-access/{nonce,grant}`): the runner-signed grant of the two
  Balchemy-provided Solana RPC sources, with the same runner proof as the other runner routes. `validateRunnerRpcAccessGrant` is a
  strict parser of grant version 1 (exact keys, https URLs kept exactly as sent, the closed provider set `RUNNER_RPC_ACCESS_PROVIDERS`,
  two different providers, `bearer` only on source a, `header` only on source b, `none` on either). A 503 `rpc_access_unavailable`
  surfaces as machineCode `RPC_ACCESS_UNAVAILABLE` (exported as the constant `RUNNER_RPC_ACCESS_UNAVAILABLE`). Errors never quote a URL or credential.
- DCA add request (K1b): `RunnerExecutionDcaRequest` (a position-anchored buy variant, purpose `balchemy.local-agent.execution.dca-request.v1`; it carries `dca: RunnerDcaPlan` in place of the signal provenance and a required `dailyCap`), `RunnerDcaPlan` (`parentEntryBuildDigest`, `ruleRevisionId`, `rulesDigest`, `dcaPlanDigest`) and the type guard `isRunnerDcaRequest`. `RunnerExecutionBuyRequest` now also includes the DCA add, so narrow it with `isRunnerDcaRequest` before reading the signal fields. `RunnerExecutionBuildClient` parses and digests the DCA add. `RUNNER_EXECUTION_REFUSALS` gains `dca_parent_mismatch`, `dca_position_empty`, `dca_position_pending`, `dca_record_headroom`, `dca_spacing` and `dca_daily_cap_required`.
- `RunnerFirstEnableCeilingClient` (runner-signed read of the owner's spend-ceiling proposal, `nest/local-agents/first-enable-ceiling/runner/{nonce,read}`), with `runnerCeilingReadRequestDigest`, `runnerCeilingReadNonceMessage`, `validateRunnerCeilingReadNonce`, `validateRunnerCeilingProposal`, `validateRunnerCeilingReadResponse` and the bounds `RUNNER_CEILING_PER_TRADE_MAX_LAMPORTS` (10 SOL), `RUNNER_CEILING_DAILY_MAX_LAMPORTS` (100 SOL) and `RUNNER_CEILING_PROPOSAL_TTL_MS` (30 minutes). A proposal grants nothing: the read names the runner's active trading-wallet binding, and the owner's approval still goes through `RunnerOwnerApprovalClient`.
- `LlmResponse.costUsd` (optional): the charge the provider itself reported, read by the OpenAI-protocol adapter from
  OpenRouter's `usage.cost`. It is absent when no valid cost is reported and for BYOK calls (`usage.is_byok`).

## [0.7.0] — 2026-11-17

### Added

- One-step pairing on `RunnerPairingClient`: `requestIntentNonce` and `readIntent` find the pending challenge for
  the runner's own intent (`runnerPublicKey`, `localIntentNonce`) without a Challenge ID, through a single-use
  runner-signed read with its own purpose (`balchemy.local-agent.runner-intent-read.v1`) and audience.
  `submitResponse` relays the runner's pairing signature to the owner's Hub page. The static `intentReadMessage`
  returns the exact signing bytes. A receipt is accepted only for the locally approved binding digest. The types are
  not exported from the package root yet.

### Changed

- Local LLM model IDs may be `/`-segmented (OpenRouter's `vendor/model`, for example
  `google/gemini-2.5-flash`). Every ID accepted before is still accepted; empty segments and a
  leading or trailing `/` are refused. `isLlmModelId` is exported. The ID is only sent in a JSON
  request body.

---

## [0.6.0] — 2026-11-16

### Added

- Owner first-enable approval protocol for the runner: `RunnerOwnerApprovalClient`,
  `runnerFirstEnableApprovalMessage`, the digest, statement and check-code helpers, the
  nonce/challenge/read-response validators and their types. The message takes the chain id
  (`solana:mainnet`, `solana:mainnet-beta`, `solana:devnet`, `solana:testnet`) as a validated
  parameter; the runner recomputes the check code from its own request and refuses a backend
  code that differs.
- Execution request v2 for buys: `RunnerExecutionRequestV2`, `RunnerExecutionBuyRequest`,
  `RunnerDailyCap` (`{ kind: "none" }` or `{ kind: "lamports" }`) and
  `RunnerExecutionReservationV2`. v1 requests, digests and goldens are unchanged.
- `RUNNER_POSITION_NOTICES` and `RunnerPositionNotice`: the owner-positions validator accepts an
  optional `notice` (`exits_unavailable`) on an item.
- `validateRunnerRuntimeNonce` takes an optional fourth argument `sentAt`. The three refusals that
  only a clock difference explains carry `details.reason: "clock_skew"` (a lease receipt whose
  server time is more than 5 s from this clock, a nonce issued more than 5 s ahead, an expired
  nonce Balchemy issued more than 5 s before the request was sent). Codes, messages and every
  accept or refuse outcome are unchanged.

### Changed

- Released together with `balchemy@0.6.0`; `@balchemyai/agent-rules` stays at 1.1.0. Publish the
  SDK first, then the CLI. Restart a running Balchemy runner after upgrading the CLI.
- Older SDK versions (0.4.x and 0.5.0) refuse an owner-positions item that carries `notice`
  (closed validator, fails closed). Upgrade the SDK together with the CLI.

---

## [0.5.0] — 2026-11-11

### Added

- `RunnerDecisionReportClient`: runner-signed, bounded per-decision reports for
  Hub, with the closed action and hold-reason enums it validates.
- Runtime lease bodies and receipts accept an optional keystore observation
  (`lock` and the build's fixed `exits` capability, no address or key material),
  validated by `validateRunnerKeystoreObservation`; older bodies keep their
  digest.

### Changed

- Released together with `balchemy@0.5.0`; `@balchemyai/agent-rules` stays at
  1.1.0. Restart a running Balchemy runner after upgrading the CLI.

## [0.4.0] — 2026-11-09

### Added

- Local-runner protocol clients for a user-owned background runner: control,
  signals, research, trading-wallet binding, execution build and execution
  submit clients, exported alongside the existing MCP and onboarding clients.
- Runner-signed swap relay, submission journal and reconciliation client
  support, and build-time decision provenance re-checks.
- Live-arming (`live_unarmed` / `live_armed`) and spend-limit support in the
  runner protocol, plus the exits protocol (sell assessment, exit guard, owner
  positions) for the runner.
- Dependency on the shared deterministic rules package
  `@balchemyai/agent-rules` through the paired CLI.

### Changed

- The telemetry reporter now reports the SDK version read from this package's
  own `package.json` instead of a hard-coded constant.
- Added a `LICENSE` file (MIT) to the published package.

### Notes

- The local-runner clients target the runner pairing and shadow-decision
  protocol. Live trading is not available in this release; execution stays
  non-executing until every deterministic contract gate is delivered and
  verified.
- Publish order: `@balchemyai/agent-rules@1.1.0`, then
  `@balchemyai/agent-sdk@0.4.0`, then `balchemy@0.4.0`.

## [0.3.11] — 2026-07-01

### Fixed

- Recover the `0.3.10` npm release by restoring the complete SDK root export
  surface for `BalchemyClient`, `agentReadinessReport`, `agentContextSnapshot`,
  `agentMarketBrief`, `agentCandidateReport`, and `agentRiskReport`.
- Keep the paired `balchemy` CLI dependency aligned with
  `@balchemyai/agent-sdk@0.3.11`.

### Notes

- `0.3.10` was published with an incomplete SDK root export surface; consumers
  should use `0.3.11` instead.
- No live-trade proof, Base live coverage, or source-owner payout rails are
  claimed by this package release.
- Publish `@balchemyai/agent-sdk@0.3.11` before `balchemy@0.3.11` so the CLI
  dependency resolves from npm semver.

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
- The published `0.3.10` package pair has an incomplete SDK root export surface;
  use `0.3.11` instead.
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
