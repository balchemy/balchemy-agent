import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSdkError, RunnerAssessmentClient, runnerAssessmentRequestDigest, type RunnerAssessmentExpectedTarget,
  type RunnerAssessmentRequest, type RunnerAssessmentResponse } from "@balchemyai/agent-sdk";
import { signRunnerAssessmentProof } from "./pairing-identity.js";
import type { PrivateResearchOptions } from "./private-research.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

/** Same pinned lease/identity inputs as research; no wallet, rules or private context. The optional pacer is shared by every
 * assessment of the daemon (arming fee probe, signal decision, build re-assessment). */
export type PrivateAssessmentOptions = PrivateResearchOptions & {
  pacer?: PrivateAssessmentPacer;
  /** Longest pacing wait before this request is given up unsent (assessment_unavailable); default: only the caller's signal. */
  pacingMaxWaitMs?: number;
};
export class PrivateAssessmentError extends Error {
  constructor(readonly code: "assessment_unavailable" | "invalid_response" | "cancelled") {
    super(`Local assessment ${code}`);
    this.name = "PrivateAssessmentError";
  }
}
/** Read-only evidence; it never authorizes, arms or executes anything. */
export interface PrivateAssessmentReceipt {
  readonly expectedTarget: RunnerAssessmentExpectedTarget;
  readonly receivedAt: string;
  readonly response: RunnerAssessmentResponse;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function identity(lease: RunnerRuntimeActiveLease): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest,
    lease.runnerPublicKey, lease.instanceId, lease.epoch]);
}

export const PRIVATE_ASSESSMENT_MAX_TIMEOUT_MS = 20_000;
/** Balchemy accepts one assessment per agent per 5 s (local-agent-assessment.service.ts), counted from when it claims the
 * request, which is always before this runner holds the answer. Spacing from the previous answer plus a margin therefore
 * never meets that window; 250 ms covers clock-rate differences. */
export const PRIVATE_ASSESSMENT_SPACING_MS = 5_250;

/** M3.6: serializes each agent's assessments and starts the next one only PRIVATE_ASSESSMENT_SPACING_MS after the previous
 * one ended, so a signal's assessment right after the arming fee probe waits instead of being refused (HTTP 429 ->
 * assessment_incomplete). Read-only timing only: it never sends, retries or changes a request. The wait is cancelled by
 * the caller's signal (the signal decision's own budget still bounds it). */
export class PrivateAssessmentPacer {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #lastEnded = new Map<string, number>();
  readonly #now: () => number;
  readonly #spacingMs: number;
  constructor(options: { monotonicNow?: () => number; spacingMs?: number } = {}) {
    this.#now = options.monotonicNow ?? (() => performance.now());
    this.#spacingMs = options.spacingMs ?? PRIVATE_ASSESSMENT_SPACING_MS;
  }
  /** Runs `task` once it is this agent's turn and the spacing has elapsed. A cancelled or over-long wait sends nothing. */
  async run<T>(agentId: string, signal: AbortSignal | undefined, task: () => Promise<T>, maxWaitMs = Infinity): Promise<T> {
    const previous = this.#tails.get(agentId) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => mine);
    this.#tails.set(agentId, tail);
    let started = false;
    try {
      const deadline = this.#now() + maxWaitMs;
      await turn(previous, signal, maxWaitMs);
      const wait = (this.#lastEnded.get(agentId) ?? -Infinity) + this.#spacingMs - this.#now();
      if (wait > 0) {
        if (this.#now() + wait > deadline) throw new PrivateAssessmentError("assessment_unavailable");
        await delay(Math.ceil(wait), undefined, signal ? { signal } : undefined);
      }
      if (signal?.aborted) throw new PrivateAssessmentError("cancelled");
      started = true;
      return await task();
    } finally {
      if (started) this.#lastEnded.set(agentId, this.#now());
      release();
      // Drop the agent's entry only once the whole chain up to this caller has settled. A waiter that gave up early (its
      // bound or abort) must never let the next caller start alongside an assessment that is still running ahead of it.
      void tail.then(() => { if (this.#tails.get(agentId) === tail) this.#tails.delete(agentId); });
    }
  }
}
/** Resolves when the previous assessment of the agent ended; rejects on the caller's abort or after maxWaitMs. */
function turn(previous: Promise<void>, signal: AbortSignal | undefined, maxWaitMs: number): Promise<void> {
  if (signal?.aborted) return Promise.reject(new PrivateAssessmentError("cancelled"));
  return new Promise<void>((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const settle = (error?: PrivateAssessmentError): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", cancelled);
      if (error) reject(error); else resolve();
    };
    const cancelled = (): void => settle(new PrivateAssessmentError("cancelled"));
    signal?.addEventListener("abort", cancelled, { once: true });
    if (Number.isFinite(maxWaitMs)) {
      timer = setTimeout(() => settle(new PrivateAssessmentError("assessment_unavailable")), Math.max(0, maxWaitMs));
      timer.unref();
    }
    void previous.then(() => settle());
  });
}
/** One bounded attempt for one exact plan request. Acquisition metadata only: no nonce, signature or key. The optional
 * timeout can only shorten the 20 s ceiling and the lease. SDK validation failures of a received response surface as
 * "invalid_response"; network, timeout, abort, server rejection and local signer/lease failures stay "assessment_unavailable". */
export async function queryPrivateAssessmentReceipt(options: PrivateAssessmentOptions, agentId: string,
  request: RunnerAssessmentRequest, signal?: AbortSignal, timeoutMs?: number): Promise<PrivateAssessmentReceipt> {
  if (!options.pacer) return queryOnce(options, agentId, request, signal, timeoutMs);
  try {
    return await options.pacer.run(agentId, signal, () => queryOnce(options, agentId, request, signal, timeoutMs), options.pacingMaxWaitMs);
  }
  catch (error: unknown) {
    if (error instanceof PrivateAssessmentError) throw error;
    // An aborted pacing wait: nothing was sent.
    throw new PrivateAssessmentError(signal?.aborted ? "cancelled" : "assessment_unavailable");
  }
}

async function queryOnce(options: PrivateAssessmentOptions, agentId: string,
  request: RunnerAssessmentRequest, signal?: AbortSignal, timeoutMs?: number): Promise<PrivateAssessmentReceipt> {
  const now = options.monotonicNow ?? (() => performance.now());
  const initial = options.readLease(agentId);
  if (!initial || initial.instanceId !== options.instanceId || !Number.isSafeInteger(initial.epoch)
    || initial.epoch < 1 || !Number.isFinite(initial.remainingMs) || initial.remainingMs <= 0) {
    throw new PrivateAssessmentError("assessment_unavailable");
  }
  const pinned = identity(initial);
  const started = now();
  if (!Number.isFinite(started)) throw new PrivateAssessmentError("assessment_unavailable");
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) throw new PrivateAssessmentError("assessment_unavailable");
  const timeout = Math.min(PRIVATE_ASSESSMENT_MAX_TIMEOUT_MS, Math.floor(initial.remainingMs), Math.floor(timeoutMs ?? PRIVATE_ASSESSMENT_MAX_TIMEOUT_MS));
  if (timeout < 1) throw new PrivateAssessmentError("assessment_unavailable");
  const deadline = started + timeout;
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeout);
  timer.unref();
  const fence = (): void => {
    const lease = options.readLease(agentId);
    const current = now();
    if (controller.signal.aborted || !lease || identity(lease) !== pinned
      || !Number.isFinite(lease.remainingMs) || lease.remainingMs <= 0
      || !Number.isFinite(current) || current < started || current >= deadline) {
      throw new PrivateAssessmentError(signal?.aborted ? "cancelled" : "assessment_unavailable");
    }
  };
  let queried = false, signerFailed = false;
  try {
    fence();
    runnerAssessmentRequestDigest(request); // Validate the closed request before copying any caller data.
    const pinnedRequest = freeze(structuredClone(request));
    const expectedTarget = freeze({ frontendOrigin: initial.frontendOrigin,
      agentId: initial.agentId, bindingDigest: initial.bindingDigest, runnerPublicKey: initial.runnerPublicKey,
      instanceId: initial.instanceId, epoch: initial.epoch, request: pinnedRequest });
    const client = new RunnerAssessmentClient({ frontendOrigin: expectedTarget.frontendOrigin,
      agentId: expectedTarget.agentId, bindingDigest: expectedTarget.bindingDigest, runnerPublicKey: expectedTarget.runnerPublicKey,
      instanceId: expectedTarget.instanceId, apiBaseUrl: `${expectedTarget.frontendOrigin}/api`, timeoutMs: timeout,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      signer: (nonce, expected) => {
        // The SDK reports any signer throw as invalid_response; remember it so a lease change is not mislabelled.
        try {
          fence();
          return signRunnerAssessmentProof({ directory: options.directory, localProfileId: options.localProfileId, agentId },
            { instanceId: options.instanceId, epoch: expected.epoch, request: expected.request, nonce });
        } catch (error: unknown) { signerFailed = true; throw error; }
      },
    });
    queried = true;
    const response = await client.query(pinnedRequest, expectedTarget.epoch, controller.signal);
    fence();
    const receivedAt = new Date().toISOString();
    return freeze({ expectedTarget, receivedAt, response: structuredClone(response) });
  } catch (error: unknown) {
    const invalidResponse = queried && !signerFailed && !signal?.aborted && !controller.signal.aborted
      && error instanceof AgentSdkError && error.code === "invalid_response";
    throw new PrivateAssessmentError(signal?.aborted ? "cancelled" : invalidResponse ? "invalid_response" : "assessment_unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
