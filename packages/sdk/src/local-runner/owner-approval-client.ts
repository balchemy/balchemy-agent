import { AgentSdkError } from "../errors/agent-sdk-error";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base58Decode, base58Encode, base64, cancelledFor, CLOCK_SKEW_MS, exactWith, HEX, invalidFor, matches, pinTarget, positive, proofHttpClient,
  proofNonceMessage, sha256, signWithin, solanaAddress, targetPart, TARGET_KEYS, timestampWith, UUID, validateProofNonce, waitFor,
  type ExactFn, type RunnerProofNonce } from "./runner-proof-transport";
import { RUNNER_OWNER_APPROVAL_TTL_MS, runnerFirstEnableFields, runnerFirstEnableLocalCheckCode, type RunnerCapBasis, type RunnerFirstEnableFields,
  type RunnerSignableCap } from "./owner-approval-message";

/**
 * M3.2 S6 moment 3, runner side of the transport: the runner-signed create and read of a `first_enable` owner wallet approval
 * (backend `nest/local-agents/approvals/first-enable`). Public API client only. The read returns the stored message inputs and
 * signature; the caller must re-derive the message from its OWN facts (`runnerFirstEnableApprovalMessage`) and verify the
 * signature against its pinned paired wallet before trusting an approval. This client never does that for it.
 */
export type RunnerOwnerApprovalTarget = RunnerRuntimeTarget;
/** Closed create request: the runner's own profile, active trading-wallet binding and current caps. */
export interface RunnerFirstEnableRequest extends RunnerFirstEnableFields { version: 1 }
/** Closed read request. challengeId null: the latest stored approval for this binding (a lost local file is recoverable). */
export interface RunnerFirstEnableReadRequest { version: 1; walletBindingId: string; challengeId: string | null }
export type RunnerFirstEnableExpectedTarget = RunnerOwnerApprovalTarget & { epoch: number; request: RunnerFirstEnableRequest };
export type RunnerFirstEnableReadExpectedTarget = RunnerOwnerApprovalTarget & { epoch: number; request: RunnerFirstEnableReadRequest };
export type RunnerFirstEnableNonce = RunnerProofNonce<"balchemy.local-agent.approval.first-enable.v1">;
export type RunnerFirstEnableReadNonce = RunnerProofNonce<"balchemy.local-agent.approval.first-enable-read.v1">;
interface RunnerEnvelope { version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string; epoch: number }
/** Link: `<frontendOrigin>/hub/local-agents/<agentId>/approve/<challengeId>`; Hub shows the same check code. `checkCode` is validated
 * to equal the code recomputed from the runner's own request with this nonce and issuedAt; the CLI prints the LOCAL code
 * (`runnerFirstEnableChallengeCheckCode`). */
export interface RunnerFirstEnableChallenge extends RunnerEnvelope {
  challengeId: string; checkCode: string; nonce: string; issuedAt: string; expiresAt: string;
}
export interface RunnerFirstEnableEvidence {
  approvalId: string; nonce: string; issuedAt: string; expiresAt: string; approvedAt: string; walletChain: "solana" | "base";
  walletAddress: string; runnerPublicKey: string; actionFields: RunnerFirstEnableFields; signature: string;
}
/**
 * Transport-valid evidence whose owner signature has NOT been checked. The brand is type-only: nothing here proves an approval.
 * The runner must re-derive the message from its OWN facts and requested caps (`runnerFirstEnableApprovalMessage`, with the chain
 * id from its pinned pairing record) and verify the signature against its pinned paired wallet before it trusts or stores this.
 */
export type RunnerFirstEnableUnverifiedEvidence = Readonly<RunnerFirstEnableEvidence> & { readonly ownerSignature: "unverified" };
export type RunnerFirstEnableReadResponse = RunnerEnvelope & (
  | { state: "pending"; expiresAt: string; evidence: null }
  | { state: "approved"; expiresAt: null; evidence: RunnerFirstEnableUnverifiedEvidence }
  | { state: "none"; expiresAt: null; evidence: null });
/** Runner key: sign only the nonce message after independently checking this context. Base64, 64 bytes. */
export type RunnerFirstEnableSigner = (nonce: Readonly<RunnerFirstEnableNonce>, expected: RunnerFirstEnableExpectedTarget) => string | Promise<string>;
export type RunnerFirstEnableReadSigner = (nonce: Readonly<RunnerFirstEnableReadNonce>, expected: RunnerFirstEnableReadExpectedTarget) => string | Promise<string>;
export interface RunnerOwnerApprovalClientConfig extends RunnerOwnerApprovalTarget {
  apiBaseUrl: string; signer: RunnerFirstEnableSigner; readSigner: RunnerFirstEnableReadSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/approvals/first-enable";
const PURPOSE = "balchemy.local-agent.approval.first-enable.v1" as const;
const READ_PURPOSE = "balchemy.local-agent.approval.first-enable-read.v1" as const;
const REQUEST_PURPOSE = "balchemy.local-agent.approval.first-enable-request.v1";
const READ_REQUEST_PURPOSE = "balchemy.local-agent.approval.first-enable-read-request.v1";
const MAX_PAYLOAD_BYTES = 8 * 1024;
const invalid: () => never = invalidFor("owner approval");
const cancelled = cancelledFor("owner approval");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);
const ENVELOPE_KEYS = ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch"] as const;

function request(value: unknown): Readonly<RunnerFirstEnableRequest> {
  exact(value, ["version", "localProfileId", "tradingWalletAddress", "walletBindingId", "caps"]);
  if (value.version !== 1) invalid();
  const fields = runnerFirstEnableFields({ localProfileId: value.localProfileId, tradingWalletAddress: value.tradingWalletAddress,
    walletBindingId: value.walletBindingId, caps: value.caps });
  return Object.freeze({ version: 1, ...fields });
}
function readRequest(value: unknown): Readonly<RunnerFirstEnableReadRequest> {
  exact(value, ["version", "walletBindingId", "challengeId"]);
  if (value.version !== 1 || !matches(value.walletBindingId, UUID) || (value.challengeId !== null && !matches(value.challengeId, UUID))) invalid();
  return Object.freeze({ version: 1, walletBindingId: value.walletBindingId as string, challengeId: value.challengeId as string | null });
}
const capTuple = (value: RunnerSignableCap): string[] => (value.kind === "none" ? ["none"] : ["lamports", value.lamports]);
const basisTuple = (value: RunnerCapBasis): unknown => (value === "fixed" ? "fixed" : ["percent", value.percentBps, value.balanceLamports, value.observedAt]);
/** sha256(JSON.stringify([REQUEST_PURPOSE, 1, localProfileId, tradingWalletAddress, walletBindingId, capTuple(perTrade), capTuple(daily), basisTuple])). */
export function runnerFirstEnableRequestDigest(value: RunnerFirstEnableRequest): string {
  const r = request(value);
  return sha256([REQUEST_PURPOSE, 1, r.localProfileId, r.tradingWalletAddress, r.walletBindingId, capTuple(r.caps.perTrade), capTuple(r.caps.daily),
    basisTuple(r.caps.basis)]);
}
/** sha256(JSON.stringify([READ_REQUEST_PURPOSE, 1, walletBindingId, challengeId | null])). */
export function runnerFirstEnableReadRequestDigest(value: RunnerFirstEnableReadRequest): string {
  const r = readRequest(value);
  return sha256([READ_REQUEST_PURPOSE, 1, r.walletBindingId, r.challengeId]);
}
function expected(value: RunnerFirstEnableExpectedTarget): RunnerFirstEnableExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, request: request(value.request) });
}
function expectedRead(value: RunnerFirstEnableReadExpectedTarget): RunnerFirstEnableReadExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, request: readRequest(value.request) });
}

export function validateRunnerFirstEnableNonce(value: unknown, expectedTarget: RunnerFirstEnableExpectedTarget, now = Date.now()): RunnerFirstEnableNonce {
  const pinned = expected(expectedTarget);
  return validateProofNonce(value, pinned, PURPOSE, "approvals/first-enable", runnerFirstEnableRequestDigest(pinned.request), now, invalid);
}
export function runnerFirstEnableNonceMessage(value: RunnerFirstEnableNonce, expectedTarget: RunnerFirstEnableExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerFirstEnableNonce(value, expectedTarget, now));
}
export function validateRunnerFirstEnableReadNonce(value: unknown, expectedTarget: RunnerFirstEnableReadExpectedTarget, now = Date.now()): RunnerFirstEnableReadNonce {
  const pinned = expectedRead(expectedTarget);
  return validateProofNonce(value, pinned, READ_PURPOSE, "approvals/first-enable/read", runnerFirstEnableReadRequestDigest(pinned.request), now, invalid);
}
export function runnerFirstEnableReadNonceMessage(value: RunnerFirstEnableReadNonce, expectedTarget: RunnerFirstEnableReadExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerFirstEnableReadNonce(value, expectedTarget, now));
}

function envelope(value: Record<string, unknown>, pinned: RunnerOwnerApprovalTarget & { epoch: number }, requestDigest: string): void {
  if (value.version !== 1 || value.requestDigest !== requestDigest || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest
    || value.instanceId !== pinned.instanceId || value.epoch !== pinned.epoch) invalid();
}
function bounded<T>(value: T): T {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return value;
}

export function validateRunnerFirstEnableChallenge(value: unknown, expectedTarget: RunnerFirstEnableExpectedTarget, now = Date.now()): Readonly<RunnerFirstEnableChallenge> {
  const pinned = expected(expectedTarget);
  exact(value, [...ENVELOPE_KEYS, "challengeId", "checkCode", "nonce", "issuedAt", "expiresAt"]);
  envelope(value, pinned, runnerFirstEnableRequestDigest(pinned.request));
  if (!Number.isFinite(now) || !matches(value.challengeId, UUID) || !matches(value.checkCode, /^[0-9A-F]{6}$/) || !matches(value.nonce, HEX)) invalid();
  const issued = timestamp(value.issuedAt); const expires = timestamp(value.expiresAt);
  // A fresh challenge: issued now (within clock skew) and alive for exactly the 10-minute TTL.
  if (expires - issued !== RUNNER_OWNER_APPROVAL_TTL_MS || issued > now + CLOCK_SKEW_MS || expires <= now - CLOCK_SKEW_MS
    || expires > now + RUNNER_OWNER_APPROVAL_TTL_MS + CLOCK_SKEW_MS) invalid();
  const challenge: RunnerFirstEnableChallenge = { version: 1, requestDigest: value.requestDigest as string, agentId: pinned.agentId,
    bindingDigest: pinned.bindingDigest, instanceId: pinned.instanceId, epoch: pinned.epoch, challengeId: value.challengeId as string,
    checkCode: value.checkCode as string, nonce: value.nonce as string, issuedAt: value.issuedAt as string, expiresAt: value.expiresAt as string };
  // The backend's code must be the one the runner derives from its OWN request: other terms under this challenge refuse here.
  if (runnerFirstEnableChallengeCheckCode(challenge, pinned) !== challenge.checkCode) invalid();
  return Object.freeze(bounded(challenge));
}
/**
 * The check code the CLI must print: recomputed from the runner's own pinned identity and request plus the challenge's nonce and
 * times (never the backend's `checkCode`, which `validateRunnerFirstEnableChallenge` already requires to equal this).
 */
export function runnerFirstEnableChallengeCheckCode(challenge: Pick<RunnerFirstEnableChallenge, "nonce" | "issuedAt" | "expiresAt">,
  expectedTarget: RunnerFirstEnableExpectedTarget): string {
  const pinned = expected(expectedTarget);
  const { localProfileId, tradingWalletAddress, walletBindingId, caps } = pinned.request;
  return runnerFirstEnableLocalCheckCode({ agentId: pinned.agentId, bindingDigest: pinned.bindingDigest, runnerPublicKey: pinned.runnerPublicKey,
    nonce: challenge.nonce, issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, fields: { localProfileId, tradingWalletAddress, walletBindingId, caps } });
}

function evidence(value: unknown, pinned: RunnerFirstEnableReadExpectedTarget): RunnerFirstEnableUnverifiedEvidence {
  exact(value, ["approvalId", "nonce", "issuedAt", "expiresAt", "approvedAt", "walletChain", "walletAddress", "runnerPublicKey", "actionFields", "signature"]);
  const e = value;
  if (!matches(e.approvalId, UUID) || (pinned.request.challengeId !== null && e.approvalId !== pinned.request.challengeId) || !matches(e.nonce, HEX)
    || e.runnerPublicKey !== pinned.runnerPublicKey || typeof e.signature !== "string" || typeof e.walletAddress !== "string") invalid();
  const issued = timestamp(e.issuedAt); const expires = timestamp(e.expiresAt); const approved = timestamp(e.approvedAt);
  if (expires - issued !== RUNNER_OWNER_APPROVAL_TTL_MS || approved < issued || approved >= expires) invalid();
  if (e.walletChain === "solana") {
    const signature = base58Decode(e.signature as string);
    if (!solanaAddress(e.walletAddress) || signature === null || signature.length !== 64 || base58Encode(signature) !== e.signature) invalid();
  } else if (e.walletChain === "base") {
    if (!matches(e.walletAddress, /^0x[0-9a-f]{40}$/) || !matches(e.signature, /^0x[0-9a-fA-F]{130}$/)) invalid();
  } else invalid();
  const actionFields = runnerFirstEnableFields(e.actionFields);
  if (actionFields.walletBindingId !== pinned.request.walletBindingId) invalid();
  return Object.freeze({ approvalId: e.approvalId as string, nonce: e.nonce as string, issuedAt: e.issuedAt as string, expiresAt: e.expiresAt as string,
    approvedAt: e.approvedAt as string, walletChain: e.walletChain as "solana" | "base", walletAddress: e.walletAddress as string, runnerPublicKey: pinned.runnerPublicKey,
    actionFields, signature: e.signature as string }) as RunnerFirstEnableUnverifiedEvidence;
}
/** Closed validation of the read answer. An approved answer is transport-valid only (`RunnerFirstEnableUnverifiedEvidence`): verify it
 * against your own facts before use. */
export function validateRunnerFirstEnableReadResponse(value: unknown, expectedTarget: RunnerFirstEnableReadExpectedTarget, now = Date.now()): Readonly<RunnerFirstEnableReadResponse> {
  const pinned = expectedRead(expectedTarget);
  exact(value, [...ENVELOPE_KEYS, "state", "expiresAt", "evidence"]);
  envelope(value, pinned, runnerFirstEnableReadRequestDigest(pinned.request));
  if (!Number.isFinite(now)) invalid();
  const head = { version: 1 as const, requestDigest: value.requestDigest as string, agentId: pinned.agentId, bindingDigest: pinned.bindingDigest,
    instanceId: pinned.instanceId, epoch: pinned.epoch };
  if (value.state === "pending") {
    // Only a named challenge can be pending; it is still open now.
    if (pinned.request.challengeId === null || value.evidence !== null) invalid();
    const expires = timestamp(value.expiresAt);
    if (expires <= now - CLOCK_SKEW_MS || expires > now + RUNNER_OWNER_APPROVAL_TTL_MS + CLOCK_SKEW_MS) invalid();
    return Object.freeze(bounded<RunnerFirstEnableReadResponse>({ ...head, state: "pending", expiresAt: value.expiresAt as string, evidence: null }));
  }
  if (value.expiresAt !== null) invalid();
  if (value.state === "none") {
    if (value.evidence !== null) invalid();
    return Object.freeze(bounded<RunnerFirstEnableReadResponse>({ ...head, state: "none", expiresAt: null, evidence: null }));
  }
  if (value.state !== "approved") invalid();
  const record = evidence(value.evidence, pinned);
  if (timestamp(record.approvedAt) > now + CLOCK_SKEW_MS) invalid();
  return Object.freeze(bounded<RunnerFirstEnableReadResponse>({ ...head, state: "approved", expiresAt: null, evidence: record }));
}

export class RunnerOwnerApprovalClient {
  private readonly pinned: RunnerOwnerApprovalTarget;
  private readonly signer: RunnerFirstEnableSigner;
  private readonly readSigner: RunnerFirstEnableReadSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerOwnerApprovalClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer", "readSigner"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function" || typeof config.readSigner !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.readSigner = config.readSigner; this.timeoutMs = config.timeoutMs ?? 20_000;
    this.transport = config.fetchFn ?? fetch;
  }

  /** One bounded attempt to open a first_enable challenge for the runner's ACTIVE trading-wallet binding and current caps.
   * The caller still enforces its current runner lease. A 409 approval_stale means the binding changed. */
  async requestFirstEnable(input: RunnerFirstEnableRequest, epoch: number, callerSignal?: AbortSignal): Promise<Readonly<RunnerFirstEnableChallenge>> {
    const operation = expected({ ...this.pinned, epoch, request: input });
    return this.run(callerSignal, async (http, scope) => {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerFirstEnableRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:first-enable-nonce" }), scope, cancelled);
      const nonce = validateRunnerFirstEnableNonce(data, operation);
      const signature = await signWithin(() => this.signer(nonce, operation), nonce.expiresAt, scope, invalid, cancelled);
      validateRunnerFirstEnableNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(PATH, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        request: operation.request }, { kind: "side_effecting", operation: "local-agent:first-enable-create" }), scope, cancelled);
      return validateRunnerFirstEnableChallenge(response, operation);
    });
  }

  /** One bounded, read-only attempt: pending, approved (transport-valid, UNVERIFIED evidence) or none. */
  async readFirstEnable(input: RunnerFirstEnableReadRequest, epoch: number, callerSignal?: AbortSignal): Promise<Readonly<RunnerFirstEnableReadResponse>> {
    const operation = expectedRead({ ...this.pinned, epoch, request: input });
    return this.run(callerSignal, async (http, scope) => {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/read/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerFirstEnableReadRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:first-enable-read-nonce" }), scope, cancelled);
      const nonce = validateRunnerFirstEnableReadNonce(data, operation);
      const signature = await signWithin(() => this.readSigner(nonce, operation), nonce.expiresAt, scope, invalid, cancelled);
      validateRunnerFirstEnableReadNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/read`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        request: operation.request }, { kind: "side_effecting", operation: "local-agent:first-enable-read" }), scope, cancelled);
      return validateRunnerFirstEnableReadResponse(response, operation);
    });
  }

  private async run<T>(callerSignal: AbortSignal | undefined, body: (http: ReturnType<typeof proofHttpClient>, scope: AbortSignal) => Promise<T>): Promise<T> {
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, this.transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try { return await body(http, scope.signal); }
    catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
