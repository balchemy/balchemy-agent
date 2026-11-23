import { AgentSdkError } from "../errors/agent-sdk-error";

export type RetryOperationPolicy =
  | {
      kind: "read";
      operation: string;
    }
  | {
      kind: "side_effecting";
      operation: string;
    };

export type RetryOptions = {
  /** Maximum number of total attempts. Classified reads are capped at 3. */
  maxAttempts?: number;
  /** Total retry deadline, including sleeps. Default: 15 seconds. */
  deadlineMs?: number;
  /** Base delay in ms for exponential backoff. Default: 200 */
  baseDelayMs?: number;
  /** Maximum client-computed backoff in ms. Does not shorten provider Retry-After. */
  maxDelayMs?: number;
  /** Whether to add random jitter (±25%). Default: true */
  jitter?: boolean;
  /** Override the sleep function — useful in tests. */
  sleepFn?: (ms: number) => Promise<void>;
  /** Override the monotonic-ish clock — useful in tests. */
  nowFn?: () => number;
  /** May narrow canonical retries, but can never make an unsafe error retryable. */
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
};

export type RetryDecisionContext = {
  attempt: number;
  maxAttempts: number;
  operation: RetryOperationPolicy;
  elapsedMs: number;
  remainingDeadlineMs: number;
};

export type RetryAttemptContext = {
  attempt: number;
  remainingDeadlineMs: number;
};

const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_TOTAL_ATTEMPTS = 3;
const DEFAULT_DEADLINE_MS = 15_000;
const MAX_DEADLINE_MS = 60_000;

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(max, Math.floor(value));
}

function validateOperation(operation: RetryOperationPolicy): void {
  if (!/^[a-zA-Z0-9_.:/-]{1,128}$/.test(operation.operation)) {
    throw new Error("Retry operation must use a bounded stable identifier");
  }
}

export function defaultShouldRetry(error: unknown): boolean {
  if (!(error instanceof AgentSdkError)) {
    return false;
  }
  if (error.status === 401 || error.status === 403 || error.status === 400) {
    return false;
  }
  return error.retryable;
}

function computeDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: boolean,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  if (!jitter) {
    return exponential;
  }
  const spread = exponential * 0.25;
  return Math.round(exponential - spread + Math.random() * spread * 2);
}

function computeRetryAfterDelay(retryAfterMs: number, jitter: boolean): number {
  if (!jitter || retryAfterMs === 0) {
    return retryAfterMs;
  }
  return Math.round(retryAfterMs + Math.random() * Math.min(1_000, retryAfterMs * 0.1));
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });

function operationAttemptLimit(
  operation: RetryOperationPolicy,
  configuredMaxAttempts: number,
): number {
  if (operation.kind === "side_effecting") {
    return 1;
  }
  return Math.min(MAX_TOTAL_ATTEMPTS, configuredMaxAttempts);
}

export async function withRetry<T>(
  fn: (context: RetryAttemptContext) => Promise<T>,
  operation: RetryOperationPolicy,
  options?: RetryOptions,
): Promise<T> {
  validateOperation(operation);
  const configuredMaxAttempts = boundedPositiveInteger(
    options?.maxAttempts,
    DEFAULT_MAX_ATTEMPTS,
    MAX_TOTAL_ATTEMPTS,
  );
  const maxAttempts = operationAttemptLimit(operation, configuredMaxAttempts);
  const deadlineMs = boundedPositiveInteger(
    options?.deadlineMs,
    DEFAULT_DEADLINE_MS,
    MAX_DEADLINE_MS,
  );
  const baseDelayMs = boundedPositiveInteger(options?.baseDelayMs, 200, 30_000);
  const maxDelayMs = boundedPositiveInteger(options?.maxDelayMs, 5_000, 30_000);
  const jitter = options?.jitter ?? true;
  const sleepFn = options?.sleepFn ?? defaultSleep;
  const nowFn = options?.nowFn ?? Date.now;
  const startedAt = nowFn();
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const attemptRemainingMs = Math.max(0, deadlineMs - Math.max(0, nowFn() - startedAt));
    if (attempt > 0 && attemptRemainingMs <= 0) {
      throw lastError;
    }
    try {
      return await fn({ attempt, remainingDeadlineMs: attemptRemainingMs });
    } catch (error: unknown) {
      lastError = error;
      const elapsedMs = Math.max(0, nowFn() - startedAt);
      const remainingDeadlineMs = Math.max(0, deadlineMs - elapsedMs);
      const context: RetryDecisionContext = {
        attempt,
        maxAttempts,
        operation,
        elapsedMs,
        remainingDeadlineMs,
      };
      const canonicalRetryable = operation.kind !== "side_effecting"
        && defaultShouldRetry(error);
      const callerAllowsRetry = options?.shouldRetry
        ? options.shouldRetry(error, context)
        : true;
      const isLastAttempt = attempt === maxAttempts - 1;

      if (
        isLastAttempt
        || !canonicalRetryable
        || !callerAllowsRetry
        || remainingDeadlineMs <= 0
      ) {
        throw error;
      }

      const retryAfterMs = error instanceof AgentSdkError
        && error.retryAfterSeconds !== undefined
        ? error.retryAfterSeconds * 1_000
        : undefined;
      const delayMs = retryAfterMs !== undefined
        ? computeRetryAfterDelay(retryAfterMs, jitter)
        : computeDelay(attempt, baseDelayMs, maxDelayMs, jitter);
      if (delayMs >= remainingDeadlineMs) {
        throw error;
      }
      await sleepFn(delayMs);
    }
  }

  throw lastError ?? new Error("Retry loop terminated without a result");
}
