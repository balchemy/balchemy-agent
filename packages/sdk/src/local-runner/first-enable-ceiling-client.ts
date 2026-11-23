import { AgentSdkError } from "../errors/agent-sdk-error";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base64, cancelledFor, CLOCK_SKEW_MS, exactWith, integerTextWith, invalidFor, matches, pinTarget, positive, proofHttpClient,
  proofNonceMessage, sha256, signWithin, solanaAddress, targetPart, TARGET_KEYS, timestampWith, UUID, validateProofNonce, waitFor,
  type ExactFn, type RunnerProofNonce } from "./runner-proof-transport";

/**
 * K2 one-visit setup, runner side: the runner-signed read of the owner's spend-ceiling PROPOSAL (backend
 * `nest/local-agents/first-enable-ceiling/runner/{nonce,read}`). Public API client only. A proposal is NOT an approval and grants
 * nothing: the runner applies its own bounds, then opens a `first_enable` challenge for exactly those caps through
 * `RunnerOwnerApprovalClient.requestFirstEnable` (basis `fixed`), shows its locally computed check code, and verifies the owner's
 * evidence itself as before. The read names the runner's ACTIVE trading-wallet binding; anything else is a 409 approval_stale.
 */
export type RunnerCeilingTarget = RunnerRuntimeTarget;
export interface RunnerCeilingReadRequest { version: 1; walletBindingId: string; tradingWalletAddress: string }
export type RunnerCeilingReadExpectedTarget = RunnerCeilingTarget & { epoch: number; request: RunnerCeilingReadRequest };
export type RunnerCeilingReadNonce = RunnerProofNonce<"balchemy.local-agent.approval.first-enable-ceiling-read.v1">;
/** Lamport amounts as canonical decimal strings: 1 <= perTrade <= daily, perTrade <= 10 SOL, daily <= 100 SOL. */
export interface RunnerCeilingProposal { proposalId: string; perTradeLamports: string; dailyLamports: string; createdAt: string; expiresAt: string }
interface RunnerEnvelope { version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string; epoch: number }
export type RunnerCeilingReadResponse = RunnerEnvelope & ({ state: "none"; proposal: null } | { state: "proposed"; proposal: RunnerCeilingProposal });
/** Runner key: sign only the nonce message after independently checking this context. Base64, 64 bytes. */
export type RunnerCeilingReadSigner = (nonce: Readonly<RunnerCeilingReadNonce>, expected: RunnerCeilingReadExpectedTarget) => string | Promise<string>;
export interface RunnerCeilingClientConfig extends RunnerCeilingTarget {
  apiBaseUrl: string; readSigner: RunnerCeilingReadSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

/** The backend's ceiling bounds (lamports); a runner may apply stricter ones of its own. */
export const RUNNER_CEILING_PER_TRADE_MAX_LAMPORTS = 10_000_000_000n;
export const RUNNER_CEILING_DAILY_MAX_LAMPORTS = 100_000_000_000n;
export const RUNNER_CEILING_PROPOSAL_TTL_MS = 30 * 60_000;
const PATH = "/nest/local-agents/first-enable-ceiling/runner";
const READ_PURPOSE = "balchemy.local-agent.approval.first-enable-ceiling-read.v1" as const;
const READ_REQUEST_PURPOSE = "balchemy.local-agent.approval.first-enable-ceiling-read-request.v1";
const MAX_PAYLOAD_BYTES = 4 * 1024;
const invalid: () => never = invalidFor("spend ceiling");
const cancelled = cancelledFor("spend ceiling");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);
const integerText = integerTextWith(invalid);
const ENVELOPE_KEYS = ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch"] as const;

function readRequest(value: unknown): Readonly<RunnerCeilingReadRequest> {
  exact(value, ["version", "walletBindingId", "tradingWalletAddress"]);
  if (value.version !== 1 || !matches(value.walletBindingId, UUID) || !solanaAddress(value.tradingWalletAddress)) invalid();
  return Object.freeze({ version: 1, walletBindingId: value.walletBindingId as string, tradingWalletAddress: value.tradingWalletAddress as string });
}
/** sha256(JSON.stringify([READ_REQUEST_PURPOSE, 1, walletBindingId, tradingWalletAddress])). */
export function runnerCeilingReadRequestDigest(value: RunnerCeilingReadRequest): string {
  const r = readRequest(value);
  return sha256([READ_REQUEST_PURPOSE, 1, r.walletBindingId, r.tradingWalletAddress]);
}
function expectedRead(value: RunnerCeilingReadExpectedTarget): RunnerCeilingReadExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, request: readRequest(value.request) });
}
export function validateRunnerCeilingReadNonce(value: unknown, expectedTarget: RunnerCeilingReadExpectedTarget, now = Date.now()): RunnerCeilingReadNonce {
  const pinned = expectedRead(expectedTarget);
  return validateProofNonce(value, pinned, READ_PURPOSE, "first-enable-ceiling/runner/read", runnerCeilingReadRequestDigest(pinned.request), now, invalid);
}
export function runnerCeilingReadNonceMessage(value: RunnerCeilingReadNonce, expectedTarget: RunnerCeilingReadExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerCeilingReadNonce(value, expectedTarget, now));
}

/** Closed proposal: both amounts set and within the bounds, a 30-minute life, not expired, not issued in the future. */
export function validateRunnerCeilingProposal(value: unknown, now = Date.now()): Readonly<RunnerCeilingProposal> {
  exact(value, ["proposalId", "perTradeLamports", "dailyLamports", "createdAt", "expiresAt"]);
  if (!Number.isFinite(now) || !matches(value.proposalId, UUID)) invalid();
  const perTrade = integerText(value.perTradeLamports, 1n, RUNNER_CEILING_PER_TRADE_MAX_LAMPORTS);
  const daily = integerText(value.dailyLamports, 1n, RUNNER_CEILING_DAILY_MAX_LAMPORTS);
  if (perTrade > daily) invalid();
  const created = timestamp(value.createdAt); const expires = timestamp(value.expiresAt);
  if (expires - created !== RUNNER_CEILING_PROPOSAL_TTL_MS || created > now + CLOCK_SKEW_MS || expires <= now - CLOCK_SKEW_MS) invalid();
  return Object.freeze({ proposalId: value.proposalId as string, perTradeLamports: value.perTradeLamports as string, dailyLamports: value.dailyLamports as string,
    createdAt: value.createdAt as string, expiresAt: value.expiresAt as string });
}

export function validateRunnerCeilingReadResponse(value: unknown, expectedTarget: RunnerCeilingReadExpectedTarget, now = Date.now()): Readonly<RunnerCeilingReadResponse> {
  const pinned = expectedRead(expectedTarget);
  exact(value, [...ENVELOPE_KEYS, "state", "proposal"]);
  if (value.version !== 1 || value.requestDigest !== runnerCeilingReadRequestDigest(pinned.request) || value.agentId !== pinned.agentId
    || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId || value.epoch !== pinned.epoch) invalid();
  const head = { version: 1 as const, requestDigest: value.requestDigest as string, agentId: pinned.agentId, bindingDigest: pinned.bindingDigest,
    instanceId: pinned.instanceId, epoch: pinned.epoch };
  if (value.state === "none") {
    if (value.proposal !== null) invalid();
    return Object.freeze({ ...head, state: "none" as const, proposal: null });
  }
  if (value.state !== "proposed") invalid();
  return Object.freeze({ ...head, state: "proposed" as const, proposal: validateRunnerCeilingProposal(value.proposal, now) });
}

export class RunnerFirstEnableCeilingClient {
  private readonly pinned: RunnerCeilingTarget;
  private readonly readSigner: RunnerCeilingReadSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerCeilingClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "readSigner"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.readSigner !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.readSigner = config.readSigner; this.timeoutMs = config.timeoutMs ?? 20_000;
    this.transport = config.fetchFn ?? fetch;
  }

  /** One bounded, read-only attempt: the owner's current proposal for this pairing, or none. A 409 approval_stale means the request
   * did not name the agent's ACTIVE trading-wallet binding (bind first). The caller still enforces its current runner lease. */
  async readProposal(input: RunnerCeilingReadRequest, epoch: number, callerSignal?: AbortSignal): Promise<Readonly<RunnerCeilingReadResponse>> {
    const operation = expectedRead({ ...this.pinned, epoch, request: input });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, this.transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerCeilingReadRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:ceiling-read-nonce" }), scope.signal, cancelled);
      const nonce = validateRunnerCeilingReadNonce(data, operation);
      const signature = await signWithin(() => this.readSigner(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      validateRunnerCeilingReadNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/read`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        request: operation.request }, { kind: "side_effecting", operation: "local-agent:ceiling-read" }), scope.signal, cancelled);
      return validateRunnerCeilingReadResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
