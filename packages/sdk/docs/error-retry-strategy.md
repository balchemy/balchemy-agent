# Error Classification and Retry Strategy

## Error Classes

- `auth_error`: JWT/identity mismatch, unauthorized onboarding.
- `policy_error`: guardrail rejection, invalid payload, unsupported mode/provider.
- `rate_limit_error`: endpoint throttling.
- `provider_auth_error`: upstream provider verify authorization failure.
- `network_error`: timeout, DNS, transport errors.
- `execution_error`: MCP call returned JSON-RPC error.
- `invalid_response`: malformed payload.
- `unknown_error`: fallback.

## Recommended Retry Rules

- `rate_limit_error`: exponential backoff with jitter (`2s`, `5s`, `10s`, `20s`).
- `network_error`: bounded retries (`max=3`) with linear backoff (`1s`, `2s`, `3s`).
- `execution_error`: retry only if tool is idempotent (`tools/list`, status calls).
- `policy_error` / `auth_error` / `provider_auth_error`: do not blind-retry; require input or credential fix.

## Safe Retry Gate

Retry only when all conditions hold:

1. Error class is retryable (`network_error` or `rate_limit_error`).
2. Operation is idempotent or duplicate-safe.
3. Retry budget for the request has remaining attempts.
