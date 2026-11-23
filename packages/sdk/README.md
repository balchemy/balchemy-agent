# @balchemyai/agent-sdk

TypeScript SDK for the Balchemy local runner. It holds the signed runner
protocol clients (pairing, control, runtime, research, assessment, execution,
signals, launchpad subscriptions, RPC access) and the local LLM adapters that
the `balchemy` CLI runner uses. The SDK holds no keys; the runner signs.

Balchemy does not ask an inner model to make trade decisions. The runner's
outer brain decides, Balchemy checks policy, executes through the authorized
path, and keeps the record.

The MCP client, the ERC-8004 onboarding flow, the token store, SSE streaming and
the external agent loop were removed in `0.9.0` (see the changelog). Earlier
versions are not deprecated, but they are no longer developed.

## Release Line

The SDK and the `balchemy` CLI ship together at the same version; publish the
SDK first, then the CLI. Version `0.4.0` added the local-runner protocol clients
and `0.9.0` removed the legacy MCP and onboarding surfaces (see the changelog).

The ownership model keeps trading keys, model calls and private agent context in
the user's background runner. Local pairing and signing do not by themselves
authorize live trading.

## Install

```sh
npm install @balchemyai/agent-sdk
```

## Unreleased local runner identity client

`RunnerPairingClient` is the candidate public client for fixed-purpose pairing
reads. It uses the configured Hub origin's `/api` proxy, rejects redirects, and
accepts no owner session token. It does not create wallets, issue execution
credentials, or enable trading.

Pin `frontendOrigin`, `apiBaseUrl` (`frontendOrigin + "/api"`), the runner's
Ed25519 public key and its locally generated intent. Request a nonce for exactly
one challenge or receipt read, validate its fixed-purpose bytes with
`runnerPairingReadMessage`, and sign those bytes with the dedicated local runner
identity. Do not use a trading-wallet key or expose a general supplied-text
signer. The CLI implements this private-key boundary; the SDK holds no keys.

Receipt reads require the binding digest durably saved at deliberate local
approval. `validateRunnerPairingBinding` validates a public binding only; it is
not proof that a request is still pending or that pairing committed.
`validateRunnerPairingResponse` separately checks the pending request or matching
committed receipt. A receipt can be recovered after the original request expires,
but its committed time must fall within that original validity window. Failed
reads are not automatically replayed; explicit recovery obtains a fresh nonce.

This candidate protocol must be released with its matching backend and CLI.
Source tests do not establish deployed availability or full local-agent readiness.

## Unreleased local runner research client

`RunnerResearchClient` connects a durably paired runner to three public reports:
`market_brief`, `candidate_report` and `risk_report`, for Solana or Base. Requests
contain closed public fields such as the chain and exact asset address; they do
not accept chat, prompts, rules, credentials, arbitrary tools or URLs.

Pin the adopted origin, agent, binding digest, runner public key and current
instance. Call `query(request, epoch, signal)` only while the matching runner
lease remains current. Its signer must validate `runnerResearchNonceMessage`
against that exact target and request before signing with the dedicated local
identity. The CLI implements this check; a trading-wallet key is not used.

One deadline covers nonce, signing, request and body reading. Redirects and
automatic retries are disabled. A returned `result.ok` describes tool completion:
the report may still contain missing, stale or held evidence. Inspect its report
data and observation times; neither the report nor the lease authorizes a trade.
This candidate requires matching unreleased backend/CLI code. Published package
and deployed availability remain separate from the isolated interoperability tests.

## Unreleased local Solana assessment client

`RunnerAssessmentClient` requests a read-only assessment for an exact SOL-input
plan: token, integer lamports, slippage and plan digest. The backend supplies the
existing global swap fee; the request cannot choose the fee or recipient. The
response binds fee arithmetic, quote amounts and token-safety observations to
that same request. It never contains a transaction or authorizes execution.

Pin the adopted origin, agent, binding, runner key and active lease instance.
Before signing, validate `runnerAssessmentNonceMessage` against that target,
epoch and exact request. Use the dedicated runner identity, never a trading key.
`query(request, epoch, signal)` has one bounded deadline and no automatic retry.
Private rules, prompts, model credentials and signing keys are not request fields.

`status: "complete"` means the required read sources returned usable observations;
the safety verdict can still be `block` or `require_approval`. Partial provider
failure remains `unavailable`, and every result has `executionAvailable: false`.
The client checks exact fee conservation, quote bounds, request/digest binding
and expiry. Fetch observation times do not establish an upstream publication time.
This candidate needs the matching unreleased backend and engine. Connection to
the private plan consumer, installed-package and deployed acceptance remain open.

## Unreleased local signal receipt client

`RunnerSignalsClient` uses the same paired identity and current lease boundary.
Validate `runnerSignalsNonceMessage` against the exact target and request before
signing with the dedicated runner identity. `query({ kind: "poll" }, epoch)`
returns at most 16 unacknowledged public Solana observations from verified
Telegram/Discord sources. Historical observations remain deliverable; the
consumer must check freshness before evaluating them.

Persist each complete event locally before explicitly calling
`query({ kind: "ack", eventId, eventDigest }, epoch)`. The client never ACKs or
retries automatically. An ACK records receipt only; it is not a decision,
approval or trade. Retain the original event ID and digest across recovery.
This candidate requires the matching backend. The managed daemon consumer,
local source setup UI, onchain signals and Base delivery are not yet connected;
published availability and end-to-end automation are not established.

## Unreleased local model client

`createLocalLlmAdapter` makes a text request directly from the caller's process to
the explicitly selected OpenAI or Anthropic provider. It requires an explicit
model; it does not select a cheaper model, retry, or fall back to Balchemy. Supply
the API key from the user's local secret source and never log the configuration.

```ts
import { createLocalLlmAdapter } from '@balchemyai/agent-sdk';

const model = createLocalLlmAdapter({
  provider: 'openai',
  model: selectedModel,
  apiKey: locallyLoadedApiKey,
  timeoutMs: 30_000,
});
const result = await model.chat(localMessages, 1_000, { signal: shutdownSignal });
```

OpenAI-compatible `baseUrl` requires HTTPS; plain HTTP is limited to numeric
loopback (`127.0.0.1` or `[::1]`). An explicitly supplied `fetchFn` receives private
messages and provider credentials and must remain in the user's trusted process.
Redirects are rejected. Timeout and cancellation cover response-body reading; an
aborted request may still have run or incurred cost at the provider, so this client
never retries automatically. Errors omit raw provider bodies and transport causes.

Only complete text responses are accepted. Truncation, refusal, tool calls and
unsupported content blocks fail closed. OpenAI `stop` and Anthropic `end_turn`
follow their respective [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
and [Messages](https://platform.claude.com/docs/en/api/messages/create) contracts.
The existing internal adapters keep their legacy default models; this new factory
requires the caller's choice. Provider classes and execution internals remain private.

This unreleased library boundary does not install a background service, attach a
private brain, persist memory, provision a wallet or authorize trading. It does not
establish deployed or real-provider acceptance for the owner-local runner.

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

Known codes include `auth_error`, `policy_error`, `rate_limit_error`,
`provider_auth_error`, `network_error`, `execution_error`, and
`invalid_response`.

## Notes

- Every request is proven by the runner's own signature over a fixed-purpose
  message; the SDK never accepts an owner session token.
- Failures raise `AgentSdkError` and never quote a credential or private URL.

## Docs

- [Error and retry strategy](docs/error-retry-strategy.md)
- [Release policy](docs/release-policy.md)
- [Full API reference](https://balchemy.ai/docs)
