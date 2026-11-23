import { AgentSdkError } from "../errors/agent-sdk-error";
import type { RunnerExecutionRefused, RunnerExecutionTarget } from "./execution-build-client";
import { base58Decode, base58Encode, base64, cancelledFor, CLOCK_SKEW_MS, exactWith, HEX, integerTextWith, invalidFor, matches, pinTarget,
  positive, proofHttpClient, proofNonceMessage, sha256, signWithin, targetPart, TARGET_KEYS, timestampWith, UUID,
  validateProofNonce, waitFor, type ExactFn, type RunnerProofNonce } from "./runner-proof-transport";

/** Closed relay request for a stored build (key order is the digest order; resendIdentical is always present). */
export interface RunnerExecutionSubmitRequest {
  reservationId: string; buildDigest: string; walletBindingId: string;
  /** Canonical base64 bincode wire transaction: one signature by the trading wallet over exactly the built message. */
  signedTransactionB64: string;
  /** Runner journal key ([A-Za-z0-9._:-]{1,128}); the engine binds it at the first accepted submit. */
  attemptKey: string;
  /** One more broadcast of the identical bytes (never a re-sign); the engine bounds it. */
  resendIdentical: boolean;
}
export interface RunnerExecutionStatusRequest { reservationId: string; buildDigest: string }
export type RunnerExecutionSubmitExpectedTarget = RunnerExecutionTarget & { epoch: number; request: RunnerExecutionSubmitRequest };
export type RunnerExecutionStatusExpectedTarget = RunnerExecutionTarget & { epoch: number; request: RunnerExecutionStatusRequest };
export type RunnerExecutionSubmitNonce = RunnerProofNonce<"balchemy.local-agent.execution.submit.v1">;
export type RunnerExecutionStatusNonce = RunnerProofNonce<"balchemy.local-agent.execution.status.v1">;

export const RUNNER_LOCAL_SWAP_STATES = ["awaiting_signature", "prepared", "submitted_known", "submitted_unknown", "finalized_facts_pending",
  "completed", "finalized_facts_disputed", "failed_onchain", "expired_not_landed", "build_revoked"] as const;
export type RunnerLocalSwapState = typeof RUNNER_LOCAL_SWAP_STATES[number];
/** States in which the engine never journaled signed bytes (no signature, never sent): awaiting_signature, and build_revoked (a sell
 * build revoked by the engine's post-insert position re-check before it was returned; it can never be journaled or sent). */
export const RUNNER_LOCAL_SWAP_UNJOURNALED_STATES: readonly RunnerLocalSwapState[] = Object.freeze(["awaiting_signature", "build_revoked"]);
export type RunnerLocalSwapOrderStatus = "ORDER_STATUS_PENDING" | "ORDER_STATUS_EXECUTING" | "ORDER_STATUS_FILLED" | "ORDER_STATUS_FAILED" | "ORDER_STATUS_EXPIRED"
  | "ORDER_STATUS_CANCELLED";
/** Exact proto OrderStatus name per engine state (blockchain.proto LocalSwapStatus). */
export const RUNNER_LOCAL_SWAP_ORDER_STATUS: Readonly<Record<RunnerLocalSwapState, RunnerLocalSwapOrderStatus>> = Object.freeze({
  awaiting_signature: "ORDER_STATUS_PENDING", prepared: "ORDER_STATUS_EXECUTING", submitted_known: "ORDER_STATUS_EXECUTING",
  submitted_unknown: "ORDER_STATUS_EXECUTING", finalized_facts_pending: "ORDER_STATUS_EXECUTING", finalized_facts_disputed: "ORDER_STATUS_EXECUTING",
  completed: "ORDER_STATUS_FILLED", failed_onchain: "ORDER_STATUS_FAILED", expired_not_landed: "ORDER_STATUS_EXPIRED",
  build_revoked: "ORDER_STATUS_CANCELLED" });
export type RunnerReservationState = "built" | "submitted" | "committed" | "released";
/** Server reservation state each engine state settles to (held: built/submitted). The server daily cap is a
 * swap-input cap: a committed swap counts its grossIn only (network/priority fees and rent are not counted);
 * expired_not_landed returns the whole amount, while failed_onchain returns it minus the burned network fee,
 * min(amount, networkFeeLamports), which stays counted for that UTC day. A reservationId allows at most 3 attempts
 * (same-day re-reservations after a release), and every attempt uses one of the day's 64 reservation slots. A revoked sell
 * build (build_revoked, never journaled) releases its exit reservation. */
const SETTLED: Readonly<Record<RunnerLocalSwapState, RunnerReservationState>> = Object.freeze({
  awaiting_signature: "built", prepared: "submitted", submitted_known: "submitted", submitted_unknown: "submitted",
  finalized_facts_pending: "submitted", finalized_facts_disputed: "submitted", completed: "committed", failed_onchain: "released",
  expired_not_landed: "released", build_revoked: "released" });
/** Engine states a record with an adopted re-signed copy can be in (adopted as submitted_known; it never expires). */
export const RUNNER_LOCAL_SWAP_OBSERVED_STATES: readonly RunnerLocalSwapState[] = Object.freeze(["submitted_known", "finalized_facts_pending",
  "completed", "finalized_facts_disputed", "failed_onchain"]);
/** Engine reconciliation reasons the relay forwards ('' for none or any other engine code). reconcile_blocked_insufficient_providers:
 * fewer than two independent RPC providers are configured, so the record is held with no release path (it replaced the
 * former not_found_single_rpc_origin). observed_resigned_copy: a re-signed copy was just adopted. */
export const RUNNER_LOCAL_SWAP_REASONS = ["observed_resigned_copy", "reconcile_blocked_insufficient_providers"] as const;
export type RunnerLocalSwapReason = typeof RUNNER_LOCAL_SWAP_REASONS[number] | "";
/** Server reservation state for one engine record: a record with an observed re-signed copy is never released
 * (failed_onchain stays held as submitted); completed still commits. */
export function runnerReservationSettlement(state: RunnerLocalSwapState, observedSignature: string): RunnerReservationState {
  return observedSignature !== "" && SETTLED[state] === "released" ? "submitted" : SETTLED[state];
}
/** signature is the journaled (runner-relayed) signature. observedSignature ('' when none) is a landed different-signature copy
 * of the same message the engine adopted: the wallet key signed outside the relay (the runner never re-signs) — a security
 * event, although the swap may have executed; finality and facts then refer to it and resignedCopyObserved is true. */
export interface RunnerExecutionSubmission {
  state: RunnerLocalSwapState; signature: string; orderStatus: RunnerLocalSwapOrderStatus; lastValidBlockHeight: string;
  observedSignature: string; resignedCopyObserved: boolean; reasonCode: RunnerLocalSwapReason;
}
interface RunnerRelayBase { version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string; epoch: number; completedAt: string }
export interface RunnerExecutionSubmitted extends RunnerRelayBase { outcome: "submitted"; submission: Readonly<RunnerExecutionSubmission> }
export interface RunnerExecutionStatus extends RunnerRelayBase {
  outcome: "status"; submission: Readonly<RunnerExecutionSubmission>; reservationState: RunnerReservationState;
}
/** A refusal means THIS call sent nothing; it is never proof that no earlier call sent. Any thrown error (including a
 * 5xx/timeout) is never a proven negative: keep the journal and read status. An expired build is refused
 * (reservation_build_expired) only after the server found no journaled engine record for it; otherwise the earlier
 * record is returned as submitted. */
export type RunnerExecutionSubmitResponse = RunnerExecutionRefused | RunnerExecutionSubmitted;
export type RunnerExecutionStatusResponse = RunnerExecutionRefused | RunnerExecutionStatus;
/** Runner key: sign only the matching *NonceMessage after independently checking this context. Base64, 64 bytes. */
export type RunnerExecutionSubmitSigner = (nonce: Readonly<RunnerExecutionSubmitNonce>, expected: RunnerExecutionSubmitExpectedTarget) => string | Promise<string>;
export type RunnerExecutionStatusSigner = (nonce: Readonly<RunnerExecutionStatusNonce>, expected: RunnerExecutionStatusExpectedTarget) => string | Promise<string>;
export interface RunnerExecutionSubmitClientConfig extends RunnerExecutionTarget {
  apiBaseUrl: string; submitSigner: RunnerExecutionSubmitSigner; statusSigner: RunnerExecutionStatusSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/execution";
const SUBMIT_PURPOSE = "balchemy.local-agent.execution.submit.v1" as const;
const STATUS_PURPOSE = "balchemy.local-agent.execution.status.v1" as const;
const SUBMIT_REQUEST_PURPOSE = "balchemy.local-agent.execution.submit-request.v1";
const STATUS_REQUEST_PURPOSE = "balchemy.local-agent.execution.status-request.v1";
const MAX_PAYLOAD_BYTES = 4 * 1024;
const MAX_WIRE_BYTES = 1232;
const ATTEMPT_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const SIGNED_TX_B64 = /^[A-Za-z0-9+/]{4,1644}={0,2}$/;
export const RUNNER_EXECUTION_SUBMIT_REFUSALS = ["execution_not_armed", "runtime_heartbeat_stale", "owner_control_pending", "trading_wallet_unbound", "trading_wallet_is_identity_wallet",
  "fee_policy_mismatch", "global_kill_switch_active", "chain_kill_switch_active", "provider_circuit_breaker_open", "user_trading_lock_active",
  "local_agent_kill_switch_active", "signal_event_mismatch", "source_authorization_changed", "source_approval_required", "evidence_stale",
  "evidence_mismatch", "reservation_not_found", "reservation_in_progress", "reservation_build_expired", "reservation_released",
  "reservation_committed", "build_digest_mismatch", "wallet_binding_mismatch", "signed_transaction_invalid",
  "invalid_local_submit_request", "local_submit_unavailable", "local_swap_store_unavailable", "local_swap_not_found",
  "local_submit_binding_mismatch", "local_submit_blockhash_expired", "local_submit_chain_unavailable", "local_submit_attempt_conflict",
  "local_submit_conflict"] as const;
export const RUNNER_EXECUTION_STATUS_REFUSALS = ["reservation_not_found", "reservation_in_progress", "build_digest_mismatch",
  "invalid_local_submit_request", "local_submit_unavailable", "local_swap_store_unavailable", "local_swap_not_found"] as const;
/** local_submit_build_unavailable:<r> (sell_signing_window_elapsed | build_revoked): the stored build can no longer be journaled;
 * nothing was persisted or sent. */
const SUBMIT_REASON = /^(?:local_submit_signature_invalid|local_submit_halted|local_submit_resend_refused|local_submit_build_unavailable):[a-z0-9_]{1,64}$/;
const invalid: () => never = invalidFor("execution relay");
const cancelled = cancelledFor("execution relay");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);
const integer = integerTextWith(invalid);

/** The base58 signature of a canonical one-signature wire transaction, or null. */
export function runnerSignedTransactionSignature(value: unknown): string | null {
  if (!matches(value, SIGNED_TX_B64)) return null;
  const wire = Buffer.from(value, "base64");
  if (wire.toString("base64") !== value || wire.length < 1 + 64 + 4 || wire.length > MAX_WIRE_BYTES || wire[0] !== 1) return null;
  return base58Encode(wire.subarray(1, 65));
}
function submitRequest(value: unknown): Readonly<RunnerExecutionSubmitRequest> {
  exact(value, ["reservationId", "buildDigest", "walletBindingId", "signedTransactionB64", "attemptKey"], ["resendIdentical"]);
  if (!matches(value.reservationId, UUID) || !matches(value.buildDigest, HEX) || !matches(value.walletBindingId, UUID)
    || runnerSignedTransactionSignature(value.signedTransactionB64) === null || !matches(value.attemptKey, ATTEMPT_KEY)
    || (value.resendIdentical !== undefined && typeof value.resendIdentical !== "boolean")) invalid();
  return Object.freeze({ reservationId: value.reservationId as string, buildDigest: value.buildDigest as string,
    walletBindingId: value.walletBindingId as string, signedTransactionB64: value.signedTransactionB64 as string,
    attemptKey: value.attemptKey as string, resendIdentical: value.resendIdentical === true });
}
function statusRequest(value: unknown): Readonly<RunnerExecutionStatusRequest> {
  exact(value, ["reservationId", "buildDigest"]);
  if (!matches(value.reservationId, UUID) || !matches(value.buildDigest, HEX)) invalid();
  return Object.freeze({ reservationId: value.reservationId as string, buildDigest: value.buildDigest as string });
}
export function runnerExecutionSubmitRequestDigest(value: RunnerExecutionSubmitRequest): string { return sha256([SUBMIT_REQUEST_PURPOSE, submitRequest(value)]); }
export function runnerExecutionStatusRequestDigest(value: RunnerExecutionStatusRequest): string { return sha256([STATUS_REQUEST_PURPOSE, statusRequest(value)]); }
function pinned<R>(value: RunnerExecutionTarget & { epoch: number; request: R }, parse: (request: unknown) => Readonly<R>) {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, request: parse(value.request) as R });
}
const submitTarget = (value: RunnerExecutionSubmitExpectedTarget): RunnerExecutionSubmitExpectedTarget => pinned(value, submitRequest);
const statusTarget = (value: RunnerExecutionStatusExpectedTarget): RunnerExecutionStatusExpectedTarget => pinned(value, statusRequest);

export function validateRunnerExecutionSubmitNonce(value: unknown, expectedTarget: RunnerExecutionSubmitExpectedTarget, now = Date.now()): RunnerExecutionSubmitNonce {
  const target = submitTarget(expectedTarget);
  return validateProofNonce(value, target, SUBMIT_PURPOSE, "execution/submit", runnerExecutionSubmitRequestDigest(target.request), now, invalid);
}
export function runnerExecutionSubmitNonceMessage(value: RunnerExecutionSubmitNonce, expectedTarget: RunnerExecutionSubmitExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerExecutionSubmitNonce(value, expectedTarget, now));
}
export function validateRunnerExecutionStatusNonce(value: unknown, expectedTarget: RunnerExecutionStatusExpectedTarget, now = Date.now()): RunnerExecutionStatusNonce {
  const target = statusTarget(expectedTarget);
  return validateProofNonce(value, target, STATUS_PURPOSE, "execution/status", runnerExecutionStatusRequestDigest(target.request), now, invalid);
}
export function runnerExecutionStatusNonceMessage(value: RunnerExecutionStatusNonce, expectedTarget: RunnerExecutionStatusExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerExecutionStatusNonce(value, expectedTarget, now));
}

const isTxSignature = (value: unknown): value is string => matches(value, TX_SIGNATURE) && base58Decode(value)?.length === 64;
function submission(value: unknown, signature: string | null): Readonly<RunnerExecutionSubmission> {
  exact(value, ["state", "signature", "orderStatus", "lastValidBlockHeight", "observedSignature", "resignedCopyObserved", "reasonCode"]);
  const state = RUNNER_LOCAL_SWAP_STATES.find((item) => item === value.state) ?? invalid();
  if (value.orderStatus !== RUNNER_LOCAL_SWAP_ORDER_STATUS[state]) invalid();
  integer(value.lastValidBlockHeight, 1n);
  const journaled = !RUNNER_LOCAL_SWAP_UNJOURNALED_STATES.includes(state);
  if (journaled ? !isTxSignature(value.signature) : value.signature !== "") invalid();
  // A journaled result must name exactly the signature this runner signed (an unjournaled record carries none). The pin is
  // the journaled signature only: an observed re-signed copy never satisfies or replaces it.
  if (signature !== null && journaled && value.signature !== signature) invalid();
  const observed = value.observedSignature;
  if (observed !== "" && (!isTxSignature(observed) || observed === value.signature || !RUNNER_LOCAL_SWAP_OBSERVED_STATES.includes(state))) invalid();
  if (value.resignedCopyObserved !== (observed !== "")) invalid();
  if (value.reasonCode !== "" && !RUNNER_LOCAL_SWAP_REASONS.includes(value.reasonCode as typeof RUNNER_LOCAL_SWAP_REASONS[number])) invalid();
  return Object.freeze({ ...value }) as unknown as Readonly<RunnerExecutionSubmission>;
}
/** An optional caller-pinned transaction signature (base58 of 64 bytes), or null when absent. */
function expectedSignatureOf(value: unknown): string | null {
  if (value === undefined) return null;
  if (!matches(value, TX_SIGNATURE) || base58Decode(value)?.length !== 64) return invalid();
  return value;
}
function relayResponse(value: unknown, target: RunnerExecutionTarget & { epoch: number }, requestDigest: string, outcome: "submitted" | "status",
  fields: readonly string[], refusals: readonly string[], suffixed: RegExp | null, now: number): Record<string, unknown> {
  const base = ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "completedAt", "outcome"];
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const kind = Object.getOwnPropertyDescriptor(value, "outcome")?.value;
  if (kind === "refused") exact(value, [...base, "reasonCode"]);
  else if (kind === outcome) exact(value, [...base, ...fields]);
  else invalid();
  const v = value as Record<string, unknown>;
  if (!Number.isFinite(now) || v.version !== 1 || v.requestDigest !== requestDigest || v.agentId !== target.agentId
    || v.bindingDigest !== target.bindingDigest || v.instanceId !== target.instanceId || v.epoch !== target.epoch
    || Math.abs(timestamp(v.completedAt) - now) > CLOCK_SKEW_MS) invalid();
  if (kind === "refused" && (typeof v.reasonCode !== "string" || !(refusals.includes(v.reasonCode) || suffixed?.test(v.reasonCode) === true))) invalid();
  if (Buffer.byteLength(JSON.stringify(v), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return v;
}
export function validateRunnerExecutionSubmitResponse(value: unknown, expectedTarget: RunnerExecutionSubmitExpectedTarget, now = Date.now()): RunnerExecutionSubmitResponse {
  const target = submitTarget(expectedTarget);
  const v = relayResponse(value, target, runnerExecutionSubmitRequestDigest(target.request), "submitted", ["submission"],
    RUNNER_EXECUTION_SUBMIT_REFUSALS, SUBMIT_REASON, now);
  if (v.outcome === "refused") return Object.freeze({ ...v }) as unknown as RunnerExecutionRefused;
  const result = submission(v.submission, runnerSignedTransactionSignature(target.request.signedTransactionB64));
  // A relayed record is journaled: never still awaiting a signature, never a revoked build.
  if (RUNNER_LOCAL_SWAP_UNJOURNALED_STATES.includes(result.state)) invalid();
  return Object.freeze({ ...v, submission: result }) as unknown as RunnerExecutionSubmitted;
}
/** expectedSignature (optional, base58): when given, a journaled record must carry exactly that transaction signature as
 * its journaled `signature` (a record still awaiting_signature carries none and is accepted as such). An adopted
 * re-signed copy is reported separately (observedSignature, resignedCopyObserved) and never matches the pin. */
export function validateRunnerExecutionStatusResponse(value: unknown, expectedTarget: RunnerExecutionStatusExpectedTarget, now = Date.now(),
  expectedSignature?: string): RunnerExecutionStatusResponse {
  const target = statusTarget(expectedTarget); const pinnedSignature = expectedSignatureOf(expectedSignature);
  const v = relayResponse(value, target, runnerExecutionStatusRequestDigest(target.request), "status", ["submission", "reservationState"],
    RUNNER_EXECUTION_STATUS_REFUSALS, null, now);
  if (v.outcome === "refused") return Object.freeze({ ...v }) as unknown as RunnerExecutionRefused;
  const result = submission(v.submission, pinnedSignature);
  if (v.reservationState !== runnerReservationSettlement(result.state, result.observedSignature)) invalid();
  return Object.freeze({ ...v, submission: result }) as unknown as RunnerExecutionStatus;
}

export class RunnerExecutionSubmitClient {
  private readonly pinned: RunnerExecutionTarget;
  private readonly submitSigner: RunnerExecutionSubmitSigner;
  private readonly statusSigner: RunnerExecutionStatusSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerExecutionSubmitClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "submitSigner", "statusSigner"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.submitSigner !== "function" || typeof config.statusSigner !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.submitSigner = config.submitSigner; this.statusSigner = config.statusSigner;
    this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }

  /** One bounded relay attempt. Journal the signed bytes BEFORE calling. A duplicate (same attemptKey and bytes)
   * returns the same record and never re-sends; any thrown error leaves the outcome unknown (read status). */
  async submit(input: RunnerExecutionSubmitRequest, epoch: number, callerSignal?: AbortSignal): Promise<RunnerExecutionSubmitResponse> {
    const operation = submitTarget({ ...this.pinned, epoch, request: input });
    return this.attempt(callerSignal, async (http, signal) => {
      const nonce = validateRunnerExecutionSubmitNonce(await this.nonce(http, "submit-nonce", operation, runnerExecutionSubmitRequestDigest(operation.request), signal), operation);
      const signature = await signWithin(() => this.submitSigner(nonce, operation), nonce.expiresAt, signal, invalid, cancelled);
      validateRunnerExecutionSubmitNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/submit`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        request: operation.request }, { kind: "side_effecting", operation: "local-agent:execution-submit" }), signal, cancelled);
      return validateRunnerExecutionSubmitResponse(response, operation);
    });
  }

  /** One bounded status read by build digest; the server settles the reservation only from proven engine states.
   * Pass the journaled transaction signature as expectedSignature to require that a journaled record carries it. */
  async status(input: RunnerExecutionStatusRequest, epoch: number, callerSignal?: AbortSignal, expectedSignature?: string): Promise<RunnerExecutionStatusResponse> {
    const operation = statusTarget({ ...this.pinned, epoch, request: input });
    expectedSignatureOf(expectedSignature);
    return this.attempt(callerSignal, async (http, signal) => {
      const nonce = validateRunnerExecutionStatusNonce(await this.nonce(http, "status-nonce", operation, runnerExecutionStatusRequestDigest(operation.request), signal), operation);
      const signature = await signWithin(() => this.statusSigner(nonce, operation), nonce.expiresAt, signal, invalid, cancelled);
      validateRunnerExecutionStatusNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/status`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        request: operation.request }, { kind: "side_effecting", operation: "local-agent:execution-status" }), signal, cancelled);
      return validateRunnerExecutionStatusResponse(response, operation, Date.now(), expectedSignature);
    });
  }

  private nonce(http: ReturnType<typeof proofHttpClient>, route: string, operation: RunnerExecutionTarget & { epoch: number }, requestDigest: string,
    signal: AbortSignal): Promise<unknown> {
    return waitFor(() => http.post<unknown>(`${PATH}/${route}`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
      instanceId: operation.instanceId, epoch: operation.epoch, requestDigest }, { kind: "side_effecting", operation: `local-agent:execution-${route}` }),
    signal, cancelled);
  }

  private async attempt<T>(callerSignal: AbortSignal | undefined, run: (http: ReturnType<typeof proofHttpClient>, signal: AbortSignal) => Promise<T>): Promise<T> {
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, this.transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try { return await run(http, scope.signal); }
    catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
