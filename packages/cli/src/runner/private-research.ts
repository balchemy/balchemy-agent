import { performance } from "node:perf_hooks";
import { RunnerResearchClient, runnerResearchRequestDigest, type RunnerResearchExpectedTarget,
  type RunnerResearchRequest, type RunnerResearchResponse } from "@balchemyai/agent-sdk";
import { signRunnerResearchProof } from "./pairing-identity.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";

export interface PrivateResearchOptions {
  directory: string;
  localProfileId: string;
  instanceId: string;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  fetchFn?: typeof fetch;
  monotonicNow?: () => number;
}
export class PrivateResearchError extends Error {
  constructor(readonly code: "research_unavailable" | "cancelled") {
    super(`Local research ${code}`);
    this.name = "PrivateResearchError";
  }
}
export interface PrivateResearchReceipt {
  readonly expectedTarget: RunnerResearchExpectedTarget;
  readonly receivedAt: string;
  readonly response: RunnerResearchResponse;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}

function identity(lease: RunnerRuntimeActiveLease): string {
  return JSON.stringify([lease.frontendOrigin, lease.agentId, lease.bindingDigest,
    lease.runnerPublicKey, lease.instanceId, lease.epoch]);
}

/** Public facts only. Local chat/rules/history never enter this transport. */
export async function queryPrivateResearch(options: PrivateResearchOptions, agentId: string,
  request: RunnerResearchRequest, signal?: AbortSignal): Promise<RunnerResearchResponse> {
  return (await queryPrivateResearchReceipt(options, agentId, request, signal)).response;
}

/** Acquisition metadata only: no proof nonce, signature or private key. */
export async function queryPrivateResearchReceipt(options: PrivateResearchOptions, agentId: string,
  request: RunnerResearchRequest, signal?: AbortSignal): Promise<PrivateResearchReceipt> {
  const now = options.monotonicNow ?? (() => performance.now());
  const initial = options.readLease(agentId);
  if (!initial || initial.instanceId !== options.instanceId || !Number.isSafeInteger(initial.epoch)
    || initial.epoch < 1 || !Number.isFinite(initial.remainingMs) || initial.remainingMs <= 0) {
    throw new PrivateResearchError("research_unavailable");
  }
  const pinned = identity(initial);
  const started = now();
  if (!Number.isFinite(started)) throw new PrivateResearchError("research_unavailable");
  const timeout = Math.min(20_000, Math.floor(initial.remainingMs));
  if (timeout < 1) throw new PrivateResearchError("research_unavailable");
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
      throw new PrivateResearchError(signal?.aborted ? "cancelled" : "research_unavailable");
    }
  };
  try {
    fence();
    runnerResearchRequestDigest(request); // Validate the closed request before copying any caller data.
    const pinnedRequest = freeze(structuredClone(request));
    const expectedTarget = freeze({ frontendOrigin: initial.frontendOrigin,
      agentId: initial.agentId, bindingDigest: initial.bindingDigest, runnerPublicKey: initial.runnerPublicKey,
      instanceId: initial.instanceId, epoch: initial.epoch, request: pinnedRequest });
    const client = new RunnerResearchClient({ frontendOrigin: expectedTarget.frontendOrigin,
      agentId: expectedTarget.agentId, bindingDigest: expectedTarget.bindingDigest, runnerPublicKey: expectedTarget.runnerPublicKey,
      instanceId: expectedTarget.instanceId, apiBaseUrl: `${expectedTarget.frontendOrigin}/api`, timeoutMs: timeout,
      ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
      signer: (nonce, expected) => {
        fence();
        return signRunnerResearchProof({ directory: options.directory, localProfileId: options.localProfileId, agentId },
          { instanceId: options.instanceId, epoch: expected.epoch, request: expected.request, nonce });
      },
    });
    const response = await client.query(pinnedRequest, expectedTarget.epoch, controller.signal);
    fence();
    const receivedAt = new Date().toISOString();
    return freeze({ expectedTarget, receivedAt, response: structuredClone(response) });
  } catch {
    throw new PrivateResearchError(signal?.aborted ? "cancelled" : "research_unavailable");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}
