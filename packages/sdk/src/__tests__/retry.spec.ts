/**
 * withRetry — unit tests
 *
 * Covers:
 * - Success on first attempt (no retries)
 * - Retries on retryable errors (network_error, execution_error, rate_limit_error)
 * - No retry on non-retryable errors (auth_error, policy_error)
 * - Max attempts respected
 * - Exponential backoff delay scaling
 * - Retry-After header respected for rate_limit_error
 * - Custom shouldRetry predicate
 * - Plain Error is retried (non-SDK errors)
 */

import { withRetry } from '../utils/retry';
import { AgentSdkError } from '../errors/agent-sdk-error';

const noSleep = async (_ms: number): Promise<void> => undefined;

describe('withRetry', () => {
  // ── success on first attempt ──────────────────────────────────────────────
  it('returns result immediately when fn succeeds on first attempt', async () => {
    const result = await withRetry(async () => 'success', { sleepFn: noSleep });
    expect(result).toBe('success');
  });

  it('does not call sleep when fn succeeds on first attempt', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    await withRetry(async () => 42, { sleepFn });
    expect(sleepFn).not.toHaveBeenCalled();
  });

  // ── retry on network_error ────────────────────────────────────────────────
  it('retries on network_error and succeeds on second attempt', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new AgentSdkError({ code: 'network_error', message: 'connection refused' });
        }
        return 'recovered';
      },
      { sleepFn: noSleep }
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
  });

  // ── retry on execution_error (≥500) ───────────────────────────────────────
  it('retries on execution_error and succeeds on third attempt', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new AgentSdkError({ code: 'execution_error', message: 'server error', status: 503 });
        }
        return 'done';
      },
      { maxAttempts: 3, sleepFn: noSleep }
    );

    expect(result).toBe('done');
    expect(attempts).toBe(3);
  });

  // ── retry on rate_limit_error ─────────────────────────────────────────────
  it('retries on rate_limit_error', async () => {
    let attempts = 0;
    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new AgentSdkError({ code: 'rate_limit_error', message: 'too many requests', status: 429 });
        }
        return 'ok';
      },
      { sleepFn: noSleep }
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(2);
  });

  // ── no retry on auth_error ────────────────────────────────────────────────
  it('does not retry on auth_error — rethrows immediately', async () => {
    let attempts = 0;
    const err = new AgentSdkError({ code: 'auth_error', message: 'unauthorized', status: 401 });

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw err;
        },
        { sleepFn: noSleep }
      )
    ).rejects.toThrow('unauthorized');

    expect(attempts).toBe(1);
  });

  // ── no retry on policy_error ──────────────────────────────────────────────
  it('does not retry on policy_error — rethrows immediately', async () => {
    let attempts = 0;
    const err = new AgentSdkError({ code: 'policy_error', message: 'forbidden', status: 403 });

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw err;
        },
        { sleepFn: noSleep }
      )
    ).rejects.toThrow('forbidden');

    expect(attempts).toBe(1);
  });

  // ── max attempts respected ────────────────────────────────────────────────
  it('stops retrying after maxAttempts and rethrows last error', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new AgentSdkError({ code: 'network_error', message: 'always fails' });
        },
        { maxAttempts: 3, sleepFn: noSleep }
      )
    ).rejects.toMatchObject({ code: 'network_error' });

    expect(attempts).toBe(3);
  });

  it('respects maxAttempts: 1 (no retries)', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new AgentSdkError({ code: 'network_error', message: 'fail' });
        },
        { maxAttempts: 1, sleepFn: noSleep }
      )
    ).rejects.toThrow('fail');

    expect(attempts).toBe(1);
  });

  // ── Retry-After header for rate_limit_error ───────────────────────────────
  it('uses retry-after from rate_limit_error details (capped at maxDelayMs)', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let attempts = 0;

    await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new AgentSdkError({
            code: 'rate_limit_error',
            message: 'rate limited',
            status: 429,
            details: { 'retry-after': 2 }, // 2 seconds
          });
        }
        return 'ok';
      },
      { maxAttempts: 2, sleepFn, maxDelayMs: 5000, jitter: false }
    );

    expect(sleepFn).toHaveBeenCalledWith(2000); // 2s in ms
  });

  it('caps retry-after delay at maxDelayMs', async () => {
    const sleepFn = jest.fn().mockResolvedValue(undefined);
    let attempts = 0;

    await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new AgentSdkError({
            code: 'rate_limit_error',
            message: 'rate limited',
            status: 429,
            details: { 'retry-after': 300 }, // 5 minutes — exceeds maxDelayMs
          });
        }
        return 'ok';
      },
      { maxAttempts: 2, sleepFn, maxDelayMs: 5000, jitter: false }
    );

    expect(sleepFn).toHaveBeenCalledWith(5000); // Capped at maxDelayMs
  });

  // ── plain Error is retried ─────────────────────────────────────────────────
  it('retries plain Error (non-SDK) as if it were a transient failure', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('plain error');
        }
        return 'recovered';
      },
      { sleepFn: noSleep }
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(2);
  });

  // ── custom shouldRetry predicate ──────────────────────────────────────────
  it('respects custom shouldRetry predicate that blocks all retries', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new AgentSdkError({ code: 'network_error', message: 'fail' });
        },
        {
          sleepFn: noSleep,
          shouldRetry: () => false, // Never retry
        }
      )
    ).rejects.toThrow('fail');

    expect(attempts).toBe(1);
  });

  it('respects custom shouldRetry predicate that allows all retries', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) {
          throw new AgentSdkError({ code: 'auth_error', message: 'unauthorized' }); // Normally non-retryable
        }
        return 'forced-success';
      },
      {
        maxAttempts: 3,
        sleepFn: noSleep,
        shouldRetry: () => true, // Always retry regardless of error type
      }
    );

    expect(result).toBe('forced-success');
    expect(attempts).toBe(3);
  });

  // ── exponential backoff ───────────────────────────────────────────────────
  it('delays increase exponentially between retries (no jitter)', async () => {
    const delays: number[] = [];
    const sleepFn = jest.fn(async (ms: number) => {
      delays.push(ms);
    });
    let attempts = 0;

    await withRetry(
      async () => {
        attempts++;
        if (attempts < 4) {
          throw new AgentSdkError({ code: 'network_error', message: 'fail' });
        }
        return 'ok';
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 10000,
        jitter: false,
        sleepFn,
      }
    );

    // Attempt 0 → delay 100*2^0=100, attempt 1 → 200, attempt 2 → 400
    expect(delays[0]).toBe(100);
    expect(delays[1]).toBe(200);
    expect(delays[2]).toBe(400);
  });

  // ── defaultShouldRetry export ─────────────────────────────────────────────
  it('unknown_error AgentSdkError is NOT retried by default', async () => {
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new AgentSdkError({ code: 'unknown_error', message: 'unknown' });
        },
        { sleepFn: noSleep }
      )
    ).rejects.toThrow('unknown');

    // unknown_error is not in RETRYABLE_CODES → no retry
    expect(attempts).toBe(1);
  });
});
