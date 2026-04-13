# @balchemyai/agent-sdk

TypeScript SDK for Balchemy external AI agents. Handles onboarding (SIWE wallet-based or walletless Identity flow), MCP tool access, token lifecycle management, and real-time SSE event streaming.

## Installation

```sh
npm install @balchemyai/agent-sdk
```

## Auth Paths

### Path 1 — SIWE (wallet-based)

Use this when your agent controls a Solana or EVM wallet and can sign messages.

```ts
import { BalchemyAgentSdk } from "@balchemyai/agent-sdk";

const sdk = new BalchemyAgentSdk({
  apiBaseUrl: "https://api.balchemy.ai/api",
});

// 1. Request a nonce and SIWS message
const { message, nonce } = await sdk.requestSiweNonce({
  address: "YOUR_WALLET_ADDRESS",
  chainId: 8453,
  domain: "youragent.example.com",
  uri: "https://youragent.example.com",
  statement: "Sign in to Balchemy",
});

// 2. Sign `message` with your wallet (off-chain, using your signing library)
const signature = await wallet.signMessage(message);

// 3. Onboard
const response = await sdk.onboardWithSiwe({
  message,
  signature,
  agentId: "your-agent-unique-id",
  scope: "trade", // "read" | "trade"
});

const mcp = sdk.connectMcp({
  endpoint: response.mcp.endpoint,
  apiKey: response.mcp.apiKey ?? "",
});
```

### Path 2 — Identity / Walletless

Use this when your agent has an HMAC-signed identity token (for balchemy native) or ES256 JWT (for external providers) from a provider registered with Balchemy.

```ts
import { BalchemyAgentSdk } from "@balchemyai/agent-sdk";

const sdk = new BalchemyAgentSdk({
  apiBaseUrl: "https://api.balchemy.ai/api",
});

const response = await sdk.onboardWithIdentity({
  provider: "your-registered-provider-id",
  identityToken: "YOUR_PROVIDER_JWT",
  agentId: "your-agent-unique-id",
  chainId: 8453,
  scope: "trade",
});

const mcp = sdk.connectMcp({
  endpoint: response.mcp.endpoint,
  apiKey: response.mcp.apiKey ?? "",
});
```

## Using the MCP Client

```ts
// List available tools
const { tools } = await mcp.listTools();

// Natural language query
const reply = await mcp.askBot({ message: "What is the price of SOL?" });

// Execute an agent instruction
const result = await mcp.agentExecute({
  instruction: "Find a low-risk setup on Base with 50 USDC",
});

// EVM quote (read-only, no wallet interaction)
const quote = await mcp.evmQuote({
  chainId: 8453,
  sellToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
  buyToken:  "0x4200000000000000000000000000000000000006", // WETH on Base
  sellAmount: "50000000", // 50 USDC (6 decimals)
});

// EVM swap (submit: false = pending order, submit: true = on-chain execution)
const swap = await mcp.evmSwap({
  chainId: 8453,
  sellToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  buyToken:  "0x4200000000000000000000000000000000000006",
  sellAmount: "50000000",
  submit: true,
});
```

## Tool Exposure and Scope

By default the MCP endpoint exposes **7 tools**: `ask_bot`, `trade_command`, `agent_execute`, `agent_research`, `agent_portfolio`, `agent_status`, `agent_config`.

The full catalog of **106 tools** is available when the platform flag `MCP_EXPOSE_GRANULAR_TOOLS=true` is enabled on the bot. Contact the Balchemy team to enable granular tool access for your integration.

Tool scopes:

| Scope | Access |
|-------|--------|
| `"read"` | Read-only tools — market data, portfolio views, research |
| `"trade"` | All read tools + trade execution tools |

Pass `scope` during onboarding to receive an MCP key with the appropriate permissions.

## Error Handling

All SDK methods throw `AgentSdkError` on failure.

```ts
import { AgentSdkError } from "@balchemyai/agent-sdk";
import type { AgentSdkErrorCode } from "@balchemyai/agent-sdk";

try {
  const result = await mcp.agentExecute({ instruction: "..." });
} catch (err: unknown) {
  if (err instanceof AgentSdkError) {
    const code: AgentSdkErrorCode = err.code;
    // "auth_error" | "policy_error" | "rate_limit" | "provider_auth_error"
    // | "network_error" | "execution_error" | "invalid_response"
    console.error(`[${code}] ${err.message}`, err.details);
  }
}
```

## Tool Response Helpers

```ts
import { getToolText, parseToolJson, isToolError } from "@balchemyai/agent-sdk";

const response = await mcp.agentPortfolio();

if (isToolError(response)) {
  console.error("Tool returned an error:", getToolText(response));
} else {
  const data = parseToolJson(response); // T | null
  console.log(data);
}
```

## Token Management

```ts
import { TokenStore } from "@balchemyai/agent-sdk";

const store = new TokenStore({
  // Called when the stored token nears expiry — return a fresh OnboardingResponse
  refreshFn: async () => {
    return sdk.onboardWithIdentity({ ... });
  },
});

await store.set(response);
const token = await store.get(); // auto-refreshes if expiry < threshold
```

## Identity Access Token

The `OnboardingResponse` includes an `identityAccess` field when the platform issues a short-lived access token alongside the MCP key.

```ts
import type { IdentityAccess } from "@balchemyai/agent-sdk";

const access: IdentityAccess | undefined = response.identityAccess;
if (access) {
  console.log(access.scope);     // "read" | "trade"
  console.log(access.expiresAt); // ISO timestamp
}
```

## SSE Event Streaming

```ts
import { SseEventStream } from "@balchemyai/agent-sdk";
import type { SseEvent } from "@balchemyai/agent-sdk";

const stream = new SseEventStream(
  "https://api.balchemy.ai/api/events",
  response.mcp.apiKey ?? "",
  { reconnectDelayMs: 2000, maxReconnects: 5 }
);

// Async iterator
for await (const event of stream) {
  const e: SseEvent = event;
  console.log(e.event, e.data);
}

// Or callback-based
const unsubscribe = stream.subscribe(
  (event) => console.log(event),
  (err)   => console.error(err)
);
// later: unsubscribe();
```

## Identity Token Revocation

```ts
// Revoke a token by JTI
await sdk.revokeIdentityToken({ jti: "the-token-jti", ttlSeconds: 86400 });

// Check revocation status
const { revoked } = await sdk.getIdentityTokenRevokeStatus({ jti: "the-token-jti" });
```

## Platform Endpoints Reference

| Endpoint | Path | Auth |
|----------|------|------|
| MCP server | `POST /api/mcp/{publicId}` | `Authorization: Bearer <mcp-api-key>` |
| SIWE nonce | `POST /api/nest/auth/evm/nonce` | Public |
| SIWE onboarding | `POST /api/public/erc8004/onboarding/siwe` | Public |
| Walletless onboarding | `POST /api/public/erc8004/onboarding/identity` | Public |
| Token revoke | `POST /api/public/erc8004/onboarding/tokens/revoke` | Public |
| JWKS | `GET /.well-known/jwks.json` | Public |
| MCP discovery | `GET /.well-known/mcp.json` | Public |
| Agent directory | `GET /api/nest/agents/verified/page` | Public |

> Note: the JWKS endpoint is served at `/.well-known/jwks.json` (root-relative, **not** under `/api`).

## Platform Operator Setup

To enable agent onboarding, the following environment variables must be configured on the backend:

| Variable | Required | Description |
|----------|----------|-------------|
| `AGENT_WALLETLESS_ONBOARDING_ENABLED` | For walletless path | Set to `true` to enable the identity/walletless onboarding endpoint. Default: `false`. |
| `SIWE_DOMAIN_ALLOWLIST` | For SIWE path | Comma-separated list of allowed domains for SIWE message verification (e.g. `youragent.example.com,localhost`). |
| `ERC8004_IDENTITY_PROVIDERS` | For walletless path | Comma-separated list of allowed identity provider IDs (e.g. `github-actions,openclaw`). |
| `AGENT_IDENTITY_ISSUER_PRIVATE_KEY_PEM` | For identity tokens | ES256 private key (PEM or base64) for signing agent identity access tokens. Required if issuing short-lived identity tokens. |
| `API_URL` | Always | Base API URL used to build MCP endpoint URLs in onboarding responses (e.g. `https://api.balchemy.ai/api`). |

## Getting Started (Quickstart)

1. Install the SDK:
   ```sh
   npm install @balchemyai/agent-sdk
   ```

2. Create an MCP API key for your bot via the Hub UI: `Hub > Your Bot > API Keys > Create Key`.

3. Choose an auth path:
   - **SIWE (wallet-based):** Your agent must control an EVM wallet and can sign messages.
   - **Walletless (identity token):** Your agent has an HMAC-signed identity token (balchemy native) or ES256 JWT (external provider) from a registered provider. The platform operator must set `AGENT_WALLETLESS_ONBOARDING_ENABLED=true`.

4. Run the relevant code example in the [Auth Paths](#auth-paths) section above.

5. Use the returned `mcp.endpoint` and `mcp.apiKey` to make MCP tool calls.

6. The MCP key is scoped — `"read"` for read-only tools, `"trade"` for trade execution tools. Choose at onboarding time via the `scope` parameter.

## Notes

- `agent_seed_request` is disabled on the platform. The `requestSeed()` method exists for backward compatibility but always throws a deterministic `AgentSdkError` with code `"execution_error"`.
- `apiBaseUrl` must include the `/api` path segment and must **not** have a trailing slash.
- The JWKS endpoint is at `/.well-known/jwks.json` (root-relative). Do not prefix with `/api`.
- If walletless onboarding returns HTTP 403 with `code: "FEATURE_DISABLED"`, the platform operator needs to set `AGENT_WALLETLESS_ONBOARDING_ENABLED=true`.

## Docs

- [Error and retry strategy](docs/error-retry-strategy.md)
- [Python parity backlog](docs/python-parity-backlog.md)
- [Partner integration checklist](docs/partner-integration-checklist.md)
- [Release policy](docs/release-policy.md)
- Full API reference: [https://balchemy.ai/docs](https://balchemy.ai/docs)
