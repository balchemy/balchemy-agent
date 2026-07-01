/**
 * Retry utility with exponential backoff + jitter.
 *
 * Retries only on transient errors (network_error, execution_error ≥500,
 * rate_limit_error with Retry-After support).
 *
 * Usage:
 *   const result = await withRetry(() => fetch(...), { maxAttempts: 3 });
 */

import { AgentSdkError } from "../errors/agent-sdk-error";
import type { AgentSdkErrorCode } from "../errors/error-codes";

export type RetryOptions = {
  /** Maximum number of total attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Default: 200 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 5000 */
  maxDelayMs?: number;
  /** Whether to add random jitter (±25%). Default: true */
  jitter?: boolean;
  /** Override the sleep function — useful in tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Optional retry predicate for endpoint/error-aware policies. */
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
};

export type RetryDecisionContext = {
  attempt: number;
  maxAttempts: number;
};

const RETRYABLE_CODES: Set<AgentSdkErrorCode> = new Set([
  "network_error",
  "execution_error",
  "rate_limit_error",
]);

export function defaultShouldRetry(error: unknown): boolean {
  if (error instanceof AgentSdkError) {
    return RETRYABLE_CODES.has(error.code);
  }
  // Plain Error (e.g. AbortError on timeout) — always retry
  return error instanceof Error;
}

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean
): number {
  // Exponential: base * 2^attempt  (attempt 0-indexed)
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  if (!jitter) {
    return exponential;
  }
  // ±25% uniform jitter
  const spread = exponential * 0.25;
  return Math.round(exponential - spread + Math.random() * spread * 2);
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    // globalThis.setTimeout is available in both Node.js and browser environments
    globalThis.setTimeout(resolve, ms);
  });

export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const maxAttempts = options?.maxAttempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 200;
  const maxDelayMs = options?.maxDelayMs ?? 5000;
  const jitter = options?.jitter ?? true;
  const sleepFn = options?.sleepFn ?? defaultSleep;
  const shouldRetry =
    options?.shouldRetry ??
    ((error: unknown): boolean => defaultShouldRetry(error));

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error;

      const isLastAttempt = attempt === maxAttempts - 1;
      if (
        isLastAttempt ||
        !shouldRetry(error, {
          attempt,
          maxAttempts,
        })
      ) {
        throw error;
      }

      // If rate-limited with a Retry-After hint, respect it (capped)
      let delayMs = computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      if (
        error instanceof AgentSdkError &&
        error.code === "rate_limit_error" &&
        typeof error.details === "object" &&
        error.details !== null
      ) {
        const details = error.details as Record<string, unknown>;
        const retryAfterSec =
          typeof details["retry-after"] === "number"
            ? details["retry-after"]
            : typeof details["retryAfter"] === "number"
              ? details["retryAfter"]
              : null;
        if (retryAfterSec !== null) {
          delayMs = Math.min(retryAfterSec * 1000, maxDelayMs);
        }
      }

      await sleepFn(delayMs);
    }
  }

  throw lastError;
}
