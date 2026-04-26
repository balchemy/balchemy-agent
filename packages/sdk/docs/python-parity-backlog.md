# Python SDK Minimum Parity Backlog

## Must-Have

1. `onboard_with_siwe(message, signature, agent_id)`
2. `onboard_with_identity(provider, identity_token, agent_id, chain_id=8453)`
3. `connect_mcp(endpoint, api_key)`
4. `list_tools()` and `call_tool(name, arguments)`
5. Error classes aligned with TS SDK codes

## Should-Have

1. Built-in timeout and retry policy helpers
2. SSE fallback parsing parity
3. Typed response dataclasses

## Nice-to-Have

1. Async client (`httpx`) and sync wrapper
2. CLI helper for onboarding smoke checks
