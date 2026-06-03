# @balchemyai/agent-sdk

TypeScript SDK for external agents that connect to Balchemy through MCP. Use it
to onboard an agent, request scoped access, call tools, refresh tokens, and
consume SSE events.

Balchemy does not ask an inner model to make trade decisions. Your outer LLM
chooses tools. Balchemy checks policy, executes through the authorized path, and
keeps the record.

## Install

```sh
npm install @balchemyai/agent-sdk
```

## Create a Client

```ts
import { BalchemyAgentSdk } from "@balchemyai/agent-sdk";

const sdk = new BalchemyAgentSdk({
  apiBaseUrl: "https://api.balchemy.ai/api",
});
```

`apiBaseUrl` includes `/api` and has no trailing slash.

## Auth Path 1: SIWE

Use this path when the agent controls a wallet and can sign an off-chain
message.

```ts
import { BalchemyAgentSdk } from "@balchemyai/agent-sdk";

const sdk = new BalchemyAgentSdk({
  apiBaseUrl: "https://api.balchemy.ai/api",
});

const { message } = await sdk.requestSiweNonce({
  address: "YOUR_WALLET_ADDRESS",
  chainId: 8453,
  domain: "agent.example.com",
  uri: "https://agent.example.com",
  statement: "Sign in to Balchemy",
});

const signature = await wallet.signMessage(message);

const response = await sdk.onboardWithSiwe({
  message,
  signature,
  agentId: "agent-example",
  scope: "trade",
});

const mcp = sdk.connectMcp({
  endpoint: response.mcp.endpoint,
  apiKey: response.mcp.apiKey ?? "",
});
```

## Auth Path 2: Walletless Identity

Use this path when the platform operator has registered an identity provider and
the agent holds a valid HMAC identity token or ES256 JWT.

```ts
import { BalchemyAgentSdk } from "@balchemyai/agent-sdk";

const sdk = new BalchemyAgentSdk({
  apiBaseUrl: "https://api.balchemy.ai/api",
});

const response = await sdk.onboardWithIdentity({
  provider: "registered-provider-id",
  identityToken: "PROVIDER_JWT",
  agentId: "agent-example",
  chainId: 8453,
  scope: "trade",
});

const mcp = sdk.connectMcp({
  endpoint: response.mcp.endpoint,
  apiKey: response.mcp.apiKey ?? "",
});
```

If the endpoint returns `FEATURE_DISABLED`, the backend needs
`AGENT_WALLETLESS_ONBOARDING_ENABLED=true`.

## MCP Calls

```ts
const { tools } = await mcp.listTools();

const reply = await mcp.askBot({
  message: "What is the price of SOL?",
});
```

For other tools, call the runtime-advertised name returned by `tools/list`:

```ts
const research = await mcp.callTool("ask_bot", {
  message: "Find low-risk Base setups with deep liquidity.",
});
```

The SDK does not expose typed swap/trade helper methods from the root client.
Privileged tools require the backend-advertised tool surface, the right MCP key
scope, replay/rate protection, and the approved product flow.

## Scope

| Scope | Access |
| --- | --- |
| `read` | Market data, portfolio views, research, status |
| `trade` | Read tools plus trade execution tools |

The default MCP endpoint exposes a curated agent-facing surface for chat,
execution, setup, behavior rules, portfolio/status, and subscriptions. Granular
internal tools stay hidden unless the platform flag
`MCP_EXPOSE_GRANULAR_TOOLS=true` is enabled for the bot.

## Errors

All SDK methods throw `AgentSdkError` on failure.

```ts
import { AgentSdkError } from "@balchemyai/agent-sdk";
import type { AgentSdkErrorCode } from "@balchemyai/agent-sdk";

type SdkFailure = {
  code: AgentSdkErrorCode;
  message: string;
};

function toSdkFailure(err: unknown): SdkFailure | null {
  if (!(err instanceof AgentSdkError)) {
    return null;
  }

  return {
    code: err.code,
    message: err.message,
  };
}
```

Known codes include `auth_error`, `policy_error`, `rate_limit`,
`provider_auth_error`, `network_error`, `execution_error`, and
`invalid_response`.

## Tool Response Helpers

```ts
import { getToolText, isToolError, parseToolJson } from "@balchemyai/agent-sdk";

const response = await mcp.callTool("agent_status", {});

const status = isToolError(response)
  ? { error: getToolText(response) }
  : { data: parseToolJson(response) };
```

## Token Store

```ts
import { TokenStore } from "@balchemyai/agent-sdk";

const store = new TokenStore({
  refreshFn: async () =>
    sdk.onboardWithIdentity({
      provider: "registered-provider-id",
      identityToken: "PROVIDER_JWT",
      agentId: "agent-example",
      chainId: 8453,
      scope: "trade",
    }),
});

await store.set(response);
const token = await store.get();
```

The store refreshes when the token is near expiry.

## Identity Access Token

`OnboardingResponse` includes `identityAccess` when the platform issues a
short-lived identity access token beside the MCP key.

```ts
import type { IdentityAccess } from "@balchemyai/agent-sdk";

const access: IdentityAccess | undefined = response.identityAccess;
const scope = access?.scope;
const expiresAt = access?.expiresAt;
```

## SSE Events

```ts
import { SseEventStream } from "@balchemyai/agent-sdk";
import type { SseEvent } from "@balchemyai/agent-sdk";

const stream = new SseEventStream(
  `${response.mcp.endpoint}/events/sse`,
  response.mcp.apiKey ?? "",
  { reconnectDelayMs: 2000, maxReconnects: 0 }
);

async function readEvents() {
  for await (const event of stream) {
    handleEvent(event);
  }
}

function handleEvent(event: SseEvent) {
  return event;
}
```

## Identity Token Revocation

```ts
await sdk.revokeIdentityToken({
  identityToken: response.identityAccess.token,
  jti: "token-jti",
  ttlSeconds: 86400,
});

const { revoked } = await sdk.getIdentityTokenRevokeStatus({
  identityToken: response.identityAccess.token,
  jti: "token-jti",
});
```

The revoke routes are public at the HTTP guard layer, but they still require an
`Authorization: Bearer <identity-access-token>` proof matching the token ID.

## Platform Endpoints

| Endpoint | Path | Auth |
| --- | --- | --- |
| MCP server | `POST /mcp/{publicId}` | `Authorization: Bearer <mcp-api-key>` |
| SIWE nonce | `POST /api/nest/auth/evm/nonce` | Public |
| SIWE onboarding | `POST /api/public/erc8004/onboarding/siwe` | Public |
| Walletless onboarding | `POST /api/public/erc8004/onboarding/identity` | Public |
| Token revoke | `POST /api/public/erc8004/onboarding/tokens/revoke` | Bearer identity proof |
| JWKS | `GET /.well-known/jwks.json` | Public |
| MCP discovery | `GET /.well-known/mcp.json` | Public |
| Agent directory | `GET /api/nest/agents/verified/page` | Public |

JWKS is root-relative. Do not prefix it with `/api`.

## Operator Setup

| Variable | Required | Description |
| --- | --- | --- |
| `AGENT_WALLETLESS_ONBOARDING_ENABLED` | Walletless path | Enables identity onboarding. Default: `false`. |
| `SIWE_DOMAIN_ALLOWLIST` | SIWE path | Comma-separated domains allowed in SIWE verification. |
| `ERC8004_IDENTITY_PROVIDERS` | Walletless path | Registered provider IDs. |
| `AGENT_IDENTITY_ISSUER_PRIVATE_KEY_PEM` | Identity tokens | ES256 private key for short-lived identity access tokens. |
| `API_URL` | Always | Base API URL used to build MCP endpoint URLs. |

## Notes

- `agent_seed_request` is disabled on the platform.
- `requestSeed()` remains for compatibility and throws `AgentSdkError` with
  code `execution_error`.
- MCP keys are scoped. Choose `read` or `trade` during onboarding.
- Walletless onboarding requires an operator-approved provider.

## Docs

- [Error and retry strategy](docs/error-retry-strategy.md)
- [Python parity backlog](docs/python-parity-backlog.md)
- [Partner integration checklist](docs/partner-integration-checklist.md)
- [Release policy](docs/release-policy.md)
- [Full API reference](https://balchemy.ai/docs)
