# Changelog

All notable changes to `@balchemyai/agent-sdk` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

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
