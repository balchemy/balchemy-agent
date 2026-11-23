import { AgentSdkError } from "../errors/agent-sdk-error";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base64, cancelledFor, CLOCK_SKEW_MS, exactWith, HEX, integerTextWith, invalidFor, matches, pinTarget, positive, proofHttpClient,
  proofNonceMessage, sha256, signWithin, solanaAddress, targetPart, TARGET_KEYS, timestampWith, validateProofNonce, waitFor, WSOL,
  type ExactFn, type RunnerProofNonce } from "./runner-proof-transport";
import { runnerMinOutAfterPlatformFee, runnerPlatformWsolAccount } from "./solana-platform-account";

export type RunnerSellAssessmentTarget = RunnerRuntimeTarget;
/** Fixed public read request (key order is the digest order): sell grossInputAmount (token base units) of inputMint for WSOL.
 * No wallet, rules or client-selected fee; no pre-trade or signal provenance requirement (an exit is not signal-driven). */
export interface RunnerSellAssessmentRequest {
  version: 1; chain: "solana"; inputMint: string; outputMint: string; grossInputAmount: string; slippageBps: number; planDigest: string;
}
export type RunnerSellAssessmentExpectedTarget = RunnerSellAssessmentTarget & { epoch: number; request: RunnerSellAssessmentRequest };
export type RunnerSellAssessmentNonce = RunnerProofNonce<"balchemy.local-agent.assessment.sell.v1">;
export const RUNNER_SELL_MINT_REASONS = ["mint_missing", "mint_owner_invalid", "mint_data_invalid", "mint_not_initialized",
  "token_2022_transfer_fee", "token_2022_transfer_hook", "token_2022_extension_not_allowed"] as const;
export type RunnerSellMintReason = typeof RUNNER_SELL_MINT_REASONS[number];
/** The global fee taken in SOL from the proceeds (Jupiter platform fee into the platform's WSOL ATA). */
export interface RunnerSellAssessmentFee {
  source: "backend_global_fee_config"; rateBps: number; recipient: string; recipientAccount: string; feeBasis: "output_sol"; policyDigest: string;
}
export interface RunnerSellAssessmentAccounts {
  mintStatus: "available" | "not_supported"; mintReason: "" | RunnerSellMintReason; tokenProgram: string;
  tokenDecimals: number; feeAccountStatus: "available" | "unavailable" | "not_required"; contextSlot: string; observedAtMs: string;
}
/** minOut is the conservative proceeds floor routeMinOut - ceil(routeMinOut * platformFeeBps / 10000): the sell build's rule. */
export interface RunnerSellAssessmentQuote {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string; routeMinOut: string; minOut: string; slippageBps: number;
  platformFeeBps: number; platformFeeLamports: string; contextSlot: string; observedAtMs: string;
}
export type RunnerSellAssessmentReason = "" | "mint_unavailable" | "mint_not_supported" | "fee_account_unavailable" | "quote_unavailable"
  | "deadline_exceeded" | "assessment_expired";
/** Complete describes read evidence only; every result remains non-executing. */
export interface RunnerSolanaSellAssessment {
  version: 1; direction: "sell"; requestDigest: string; planDigest: string; inputMint: string; outputMint: string; grossInputAmount: string;
  slippageBps: number; startedAtMs: string; completedAtMs: string; expiresAtMs: string; status: "complete" | "unavailable";
  reasonCode: RunnerSellAssessmentReason; fee: Readonly<RunnerSellAssessmentFee>; accounts?: Readonly<RunnerSellAssessmentAccounts>;
  quote?: Readonly<RunnerSellAssessmentQuote>; executionAvailable: false; assessmentDigest: string;
}
export interface RunnerSellAssessmentResponse {
  version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string; epoch: number; completedAt: string;
  assessment: Readonly<RunnerSolanaSellAssessment>;
}
/** Runner key: sign only runnerSellAssessmentNonceMessage after independently checking this context. Base64, 64 bytes. */
export type RunnerSellAssessmentSigner = (nonce: Readonly<RunnerSellAssessmentNonce>, expected: RunnerSellAssessmentExpectedTarget) => string | Promise<string>;
export interface RunnerSellAssessmentClientConfig extends RunnerSellAssessmentTarget {
  apiBaseUrl: string; signer: RunnerSellAssessmentSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/assessment/sell";
const PURPOSE = "balchemy.local-agent.assessment.sell.v1" as const;
const REQUEST_PURPOSE = "balchemy.local-agent.assessment.sell-request.v1";
const MAX_PAYLOAD_BYTES = 16 * 1024;
/** Engine lifetime of one assessment (startedAtMs + 15000): the freshness bound an exit build enforces. */
const LIFETIME_MS = 15_000n;
/** Engine provider deadline inside the 15 s lifetime. */
const PROVIDER_TIMEOUT_MS = 12_000n;
const MAX_MS = BigInt(Number.MAX_SAFE_INTEGER);
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSESSMENT_KEYS = ["version", "direction", "requestDigest", "planDigest", "inputMint", "outputMint", "grossInputAmount", "slippageBps",
  "startedAtMs", "completedAtMs", "expiresAtMs", "status", "reasonCode", "fee", "executionAvailable", "assessmentDigest"] as const;
const invalid: () => never = invalidFor("sell assessment");
const cancelled = cancelledFor("sell assessment");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);
const integer = integerTextWith(invalid);

function request(value: unknown): Readonly<RunnerSellAssessmentRequest> {
  exact(value, ["version", "chain", "inputMint", "outputMint", "grossInputAmount", "slippageBps", "planDigest"]);
  if (value.version !== 1 || value.chain !== "solana" || value.outputMint !== WSOL || !solanaAddress(value.inputMint) || value.inputMint === WSOL
    || !positive(value.slippageBps) || value.slippageBps > 5000 || !matches(value.planDigest, HEX)) invalid();
  integer(value.grossInputAmount, 1n);
  return Object.freeze({ version: 1, chain: "solana", inputMint: value.inputMint as string, outputMint: WSOL,
    grossInputAmount: value.grossInputAmount as string, slippageBps: value.slippageBps as number, planDigest: value.planDigest as string });
}
export function runnerSellAssessmentRequestDigest(value: RunnerSellAssessmentRequest): string { return sha256([REQUEST_PURPOSE, request(value)]); }
function expected(value: RunnerSellAssessmentExpectedTarget): RunnerSellAssessmentExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, request: request(value.request) });
}
export function validateRunnerSellAssessmentNonce(value: unknown, expectedTarget: RunnerSellAssessmentExpectedTarget, now = Date.now()): RunnerSellAssessmentNonce {
  const pinned = expected(expectedTarget);
  return validateProofNonce(value, pinned, PURPOSE, "assessment/sell/query", runnerSellAssessmentRequestDigest(pinned.request), now, invalid);
}
export function runnerSellAssessmentNonceMessage(value: RunnerSellAssessmentNonce, expectedTarget: RunnerSellAssessmentExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerSellAssessmentNonce(value, expectedTarget, now));
}

/** Mirrors the engine assessment_digest (blockchain.proto GetSolanaSellAssessmentResponse). */
export function runnerSolanaSellAssessmentDigest(a: Omit<RunnerSolanaSellAssessment, "assessmentDigest">): string {
  const f = a.fee, c = a.accounts, q = a.quote;
  return sha256(["balchemy.solana-sell-assessment.v1", a.requestDigest, a.planDigest, "sell", a.inputMint, a.outputMint, a.grossInputAmount,
    a.slippageBps, a.startedAtMs, a.completedAtMs, a.expiresAtMs, a.status, a.reasonCode,
    [f.source, f.rateBps, f.recipient, f.recipientAccount, f.feeBasis, f.policyDigest],
    c ? [c.mintStatus, c.mintReason, c.tokenProgram, c.tokenDecimals, c.feeAccountStatus, c.contextSlot, c.observedAtMs] : null,
    q ? [q.inputMint, q.outputMint, q.inAmount, q.outAmount, q.routeMinOut, q.minOut, q.slippageBps, q.platformFeeBps, q.platformFeeLamports,
      q.contextSlot, q.observedAtMs] : null, false]);
}

function fee(value: unknown): Readonly<RunnerSellAssessmentFee> {
  exact(value, ["source", "rateBps", "recipient", "recipientAccount", "feeBasis", "policyDigest"]);
  const f = value;
  if (f.source !== "backend_global_fee_config" || typeof f.rateBps !== "number" || !Number.isInteger(f.rateBps) || f.rateBps < 0 || f.rateBps > 255
    || f.feeBasis !== "output_sol" || typeof f.recipient !== "string" || typeof f.recipientAccount !== "string" || !matches(f.policyDigest, HEX)
    || (f.rateBps === 0 ? f.recipient !== "" || f.recipientAccount !== ""
      : !solanaAddress(f.recipient) || !solanaAddress(f.recipientAccount) || f.recipientAccount !== runnerPlatformWsolAccount(f.recipient as string))
    || f.policyDigest !== sha256(["balchemy.solana-fee-policy.v1", "backend_global_fee_config", f.rateBps, f.recipient])) invalid();
  return Object.freeze({ source: "backend_global_fee_config", rateBps: f.rateBps as number, recipient: f.recipient as string,
    recipientAccount: f.recipientAccount as string, feeBasis: "output_sol", policyDigest: f.policyDigest as string });
}
/** Closed validation of one sell assessment for exactly `sellRequest`, mirroring the backend parseResult (the fee rate is the one the
 * assessment carries, 0..255). `now` bounds freshness: completed no later than now (+ clock skew) and still inside its 15 s lifetime. */
export function validateRunnerSolanaSellAssessment(value: unknown, sellRequest: RunnerSellAssessmentRequest, now = Date.now()): Readonly<RunnerSolanaSellAssessment> {
  const pinned = request(sellRequest); const requestDigest = runnerSellAssessmentRequestDigest(pinned);
  exact(value, ASSESSMENT_KEYS, ["accounts", "quote"]);
  const a = value;
  if (a.version !== 1 || a.direction !== "sell" || a.requestDigest !== requestDigest || a.planDigest !== pinned.planDigest
    || a.inputMint !== pinned.inputMint || a.outputMint !== pinned.outputMint || a.grossInputAmount !== pinned.grossInputAmount
    || a.slippageBps !== pinned.slippageBps || a.executionAvailable !== false || !matches(a.assessmentDigest, HEX)
    || !Number.isSafeInteger(now) || now < 1) invalid();
  const ms = (v: unknown): bigint => integer(v, 1n, MAX_MS);
  const start = ms(a.startedAtMs), end = ms(a.completedAtMs), expires = ms(a.expiresAtMs);
  if (end < start || end > BigInt(now + CLOCK_SKEW_MS) || expires - start !== LIFETIME_MS || BigInt(now) >= expires) invalid();
  const observed = (v: unknown): string => { const time = ms(v); if (time < start || time > end) invalid(); return v as string; };
  const cost = fee(a.fee); const rate = cost.rateBps;
  let accounts: Readonly<RunnerSellAssessmentAccounts> | undefined;
  if (a.accounts !== undefined) {
    const c = a.accounts; exact(c, ["mintStatus", "mintReason", "tokenProgram", "tokenDecimals", "feeAccountStatus", "contextSlot", "observedAtMs"]);
    const available = c.mintStatus === "available";
    if ((!available && c.mintStatus !== "not_supported") || typeof c.tokenDecimals !== "number" || !Number.isInteger(c.tokenDecimals)
      || c.tokenDecimals < 0 || c.tokenDecimals > 255
      || (available ? c.mintReason !== "" || (c.tokenProgram !== TOKEN_PROGRAM && c.tokenProgram !== TOKEN_2022_PROGRAM)
        : !RUNNER_SELL_MINT_REASONS.includes(c.mintReason as RunnerSellMintReason) || c.tokenProgram !== "" || c.tokenDecimals !== 0)
      || (rate === 0 ? c.feeAccountStatus !== "not_required" : c.feeAccountStatus !== "available" && c.feeAccountStatus !== "unavailable")) invalid();
    integer(c.contextSlot, 1n);
    accounts = Object.freeze({ mintStatus: available ? "available" : "not_supported", mintReason: c.mintReason as RunnerSellAssessmentAccounts["mintReason"],
      tokenProgram: c.tokenProgram as string, tokenDecimals: c.tokenDecimals as number,
      feeAccountStatus: c.feeAccountStatus as RunnerSellAssessmentAccounts["feeAccountStatus"], contextSlot: c.contextSlot as string,
      observedAtMs: observed(c.observedAtMs) });
  }
  let quote: Readonly<RunnerSellAssessmentQuote> | undefined;
  if (a.quote !== undefined) {
    const q = a.quote; exact(q, ["inputMint", "outputMint", "inAmount", "outAmount", "routeMinOut", "minOut", "slippageBps", "platformFeeBps",
      "platformFeeLamports", "contextSlot", "observedAtMs"]);
    if (q.inputMint !== pinned.inputMint || q.outputMint !== pinned.outputMint || q.inAmount !== pinned.grossInputAmount
      || q.slippageBps !== pinned.slippageBps || q.platformFeeBps !== rate) invalid();
    const out = integer(q.outAmount, 1n), routeMin = integer(q.routeMinOut, 1n), minimum = integer(q.minOut, 1n), platformFee = integer(q.platformFeeLamports);
    integer(q.contextSlot, 1n);
    // The engine's sell-quote rules: threshold <= out, floor net of the platform fee, fee <= rate of the gross output.
    if (routeMin > out || minimum !== runnerMinOutAfterPlatformFee(routeMin, rate)
      || (rate === 0 ? platformFee !== 0n : platformFee * 10000n > (out + platformFee) * BigInt(rate))) invalid();
    quote = Object.freeze({ inputMint: pinned.inputMint, outputMint: pinned.outputMint, inAmount: pinned.grossInputAmount, outAmount: q.outAmount as string,
      routeMinOut: q.routeMinOut as string, minOut: q.minOut as string, slippageBps: pinned.slippageBps, platformFeeBps: rate,
      platformFeeLamports: q.platformFeeLamports as string, contextSlot: q.contextSlot as string, observedAtMs: observed(q.observedAtMs) });
  }
  const expired = end >= expires; const deadline = a.reasonCode === "deadline_exceeded";
  const reasonCode: RunnerSellAssessmentReason = expired ? "assessment_expired" : deadline ? "deadline_exceeded" : !accounts ? "mint_unavailable"
    : accounts.mintStatus !== "available" ? "mint_not_supported" : accounts.feeAccountStatus === "unavailable" ? "fee_account_unavailable"
      : !quote ? "quote_unavailable" : "";
  if (a.reasonCode !== reasonCode || a.status !== (reasonCode === "" ? "complete" : "unavailable")
    || (deadline && (quote !== undefined || accounts !== undefined || end - start < PROVIDER_TIMEOUT_MS))
    || (!deadline && end - start > PROVIDER_TIMEOUT_MS)) invalid();
  const result: RunnerSolanaSellAssessment = { version: 1, direction: "sell", requestDigest, planDigest: pinned.planDigest, inputMint: pinned.inputMint,
    outputMint: pinned.outputMint, grossInputAmount: pinned.grossInputAmount, slippageBps: pinned.slippageBps, startedAtMs: a.startedAtMs as string,
    completedAtMs: a.completedAtMs as string, expiresAtMs: a.expiresAtMs as string, status: reasonCode === "" ? "complete" : "unavailable", reasonCode,
    fee: cost, ...(accounts ? { accounts } : {}), ...(quote ? { quote } : {}), executionAvailable: false, assessmentDigest: a.assessmentDigest as string };
  if (result.assessmentDigest !== runnerSolanaSellAssessmentDigest(result)
    || Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return Object.freeze(result);
}
export function validateRunnerSellAssessmentResponse(value: unknown, expectedTarget: RunnerSellAssessmentExpectedTarget, now = Date.now()): RunnerSellAssessmentResponse {
  const pinned = expected(expectedTarget); const requestDigest = runnerSellAssessmentRequestDigest(pinned.request);
  exact(value, ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "completedAt", "assessment"]);
  if (!Number.isFinite(now) || value.version !== 1 || value.requestDigest !== requestDigest || value.agentId !== pinned.agentId
    || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId || value.epoch !== pinned.epoch
    || Math.abs(timestamp(value.completedAt) - now) > CLOCK_SKEW_MS) invalid();
  const assessment = validateRunnerSolanaSellAssessment(value.assessment, pinned.request, now);
  // The server completes the response after the assessment and inside its lifetime.
  const completedAt = BigInt(timestamp(value.completedAt));
  if (BigInt(assessment.completedAtMs) > completedAt || completedAt >= BigInt(assessment.expiresAtMs)) invalid();
  const result = Object.freeze({ ...value, assessment }) as unknown as RunnerSellAssessmentResponse;
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return result;
}

export class RunnerSellAssessmentClient {
  private readonly pinned: RunnerSellAssessmentTarget;
  private readonly signer: RunnerSellAssessmentSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerSellAssessmentClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }
  /** A single bounded, read-only attempt (it never builds, reserves or signs a transaction); the caller still enforces its current
   * runner lease. A complete result is recorded server-side for the rest of its 15 s lifetime: an exit may only name such an assessment. */
  async query(input: RunnerSellAssessmentRequest, epoch: number, callerSignal?: AbortSignal): Promise<RunnerSellAssessmentResponse> {
    const operation = expected({ ...this.pinned, epoch, request: input });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, this.transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerSellAssessmentRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:sell-assessment-nonce" }), scope.signal, cancelled);
      const nonce = validateRunnerSellAssessmentNonce(data, operation);
      const signature = await signWithin(() => this.signer(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      validateRunnerSellAssessmentNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/query`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch,
        request: operation.request }, { kind: "side_effecting", operation: "local-agent:sell-assessment-query" }), scope.signal, cancelled);
      return validateRunnerSellAssessmentResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
