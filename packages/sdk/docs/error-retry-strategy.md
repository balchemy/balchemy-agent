# Error Classification and Retry Strategy

## Error Classes

- `auth_error`: signature or proof mismatch, unauthorized runner request.
- `policy_error`: guardrail rejection, invalid payload, unsupported mode/provider.
- `rate_limit_error`: endpoint throttling.
- `provider_auth_error`: upstream provider verify authorization failure.
- `network_error`: timeout, DNS, transport errors.
- `execution_error`: the service returned a structured execution error.
- `invalid_response`: malformed payload.
- `unknown_error`: fallback.

## Automatic Retry Rules

Classified read operations use at most three attempts within a total deadline
(15 seconds by default). Backoff starts at 200 ms with jitter, respects
`Retry-After`, and must fit within the remaining deadline. The SDK validates
operation classification before treating a call as read-only.

Protected calls and mutations always use one attempt. An
idempotency key does not authorize automatic replay. A network error, timeout,
malformed response, or unavailable terminal evidence after a mutation can mean
the outcome is unknown. Preserve the operation's idempotency key and reconcile
its authoritative status before making another change.

`policy_error`, `auth_error`, and `provider_auth_error` require input or
credential correction. `retryable` describes the failure class; it never
overrides the operation's side-effect policy.

## Safe Retry Gate

Retry only when all conditions hold:

1. Error class is retryable (`network_error` or `rate_limit_error`).
2. The operation is classified read-only; it is not a protected mutation.
3. Retry budget for the request has remaining attempts.
