import { createHash } from "node:crypto";
import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";
import type { RunnerRuntimeTarget } from "./runtime-client";

export type RunnerAssessmentTarget = RunnerRuntimeTarget;
/** Fixed public read request; no private rules, wallet or client-selected fees. */
export interface RunnerAssessmentRequest {
  version: 1; chain: "solana"; inputMint: string; outputMint: string;
  grossInputLamports: string; slippageBps: number; planDigest: string;
}
export type RunnerAssessmentExpectedTarget = RunnerAssessmentTarget & { epoch: number; request: RunnerAssessmentRequest };
export interface RunnerAssessmentNonce {
  version: 1; purpose: "balchemy.local-agent.assessment.query.v1"; audience: string; nonceId: string;
  agentId: string; bindingDigest: string; runnerPublicKey: string; instanceId: string; epoch: number;
  requestDigest: string; nonce: string; issuedAt: string; expiresAt: string;
}
export interface RunnerAssessmentFee {
  source: "backend_global_fee_config"; rateBps: number; recipient: string;
  grossInputLamports: string; feeLamports: string; netInputLamports: string; policyDigest: string;
}
export interface RunnerAssessmentQuote {
  inputMint: string; outputMint: string; inAmount: string; outAmount: string;
  minOut: string; slippageBps: number; contextSlot: string; observedAtMs: string;
}
export interface RunnerAssessmentPretrade {
  verdict: "allow" | "require_approval" | "block"; reasons: readonly string[];
  rugcheckStatus: "available" | "unavailable"; rugcheckObservedAtMs: string;
  mintStatus: "available" | "unavailable"; mintObservedAtMs: string; mintContextSlot: string;
}
/** Complete describes read evidence only. Every result remains non-executing. */
export interface RunnerSolanaAssessment {
  version: 1; requestDigest: string; planDigest: string; inputMint: string; outputMint: string;
  grossInputLamports: string; slippageBps: number; startedAtMs: string; completedAtMs: string; expiresAtMs: string;
  status: "complete" | "unavailable"; reasonCode: string; fee: Readonly<RunnerAssessmentFee>;
  quote?: Readonly<RunnerAssessmentQuote>; pretrade?: Readonly<RunnerAssessmentPretrade>;
  executionAvailable: false; assessmentDigest: string;
}
export interface RunnerAssessmentResponse {
  version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string;
  epoch: number; completedAt: string; assessment: Readonly<RunnerSolanaAssessment>;
}
/** Sign only runnerAssessmentNonceMessage after independently checking this context. */
export type RunnerAssessmentSigner = (nonce: Readonly<RunnerAssessmentNonce>, expected: RunnerAssessmentExpectedTarget) => string | Promise<string>;
export interface RunnerAssessmentClientConfig extends RunnerAssessmentTarget {
  apiBaseUrl: string; signer: RunnerAssessmentSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/assessment";
const PURPOSE = "balchemy.local-agent.assessment.query.v1";
const REQUEST_PURPOSE = "balchemy.local-agent.assessment.request.v1";
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_ENVELOPE_BYTES = 4096;
const CLOCK_SKEW_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const TARGET_KEYS = ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "instanceId"] as const;
const NONCE_KEYS = ["version", "purpose", "audience", "nonceId", "agentId", "bindingDigest", "runnerPublicKey",
  "instanceId", "epoch", "requestDigest", "nonce", "issuedAt", "expiresAt"] as const;
const WSOL = "So11111111111111111111111111111111111111112";
const U64_MAX = (1n << 64n) - 1n;
const PRETRADE_REASONS = ["signal_unavailable:rugcheck", "signal_unavailable:helius", "rugcheck_risks_present",
  "mint_authority_present", "freeze_authority_present", "high_risk_combined"] as const;

function invalid(): never {
  throw new AgentSdkError({ code: "invalid_response", message: "Invalid local-agent assessment protocol", details: { retryable: false } });
}
function cancelled(): AgentSdkError {
  return new AgentSdkError({ code: "network_error", message: "Local-agent assessment deadline or cancellation reached",
    details: { layer: "transport", code: "CLIENT_CANCELLED", retryable: false } });
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!required.every((key) => Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
    || Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) invalid();
}
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function base64(value: unknown, length: number): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const bytes = Buffer.from(value, "base64"); return bytes.length === length && bytes.toString("base64") === value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || value.length !== 24) invalid();
  const time = Date.parse(value); if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid(); return time;
}
function target(value: unknown): RunnerAssessmentTarget {
  exact(value, TARGET_KEYS);
  if (typeof value.frontendOrigin !== "string" || !matches(value.agentId, UUID) || !matches(value.instanceId, UUID)
    || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32)) invalid();
  try {
    const url = new URL(value.frontendOrigin);
    if (url.origin !== value.frontendOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  } catch { invalid(); }
  return Object.freeze({ ...value }) as unknown as RunnerAssessmentTarget;
}
function targetPart(value: RunnerAssessmentTarget): RunnerAssessmentTarget {
  return Object.fromEntries(TARGET_KEYS.map((key) => [key, value[key]])) as unknown as RunnerAssessmentTarget;
}
function solanaAsset(value: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let integer = 0n;
  for (const character of value) integer = integer * 58n + BigInt(alphabet.indexOf(character));
  let bytes = 0; for (let remaining = integer; remaining > 0n; remaining >>= 8n) bytes++;
  // Leading '1' characters encode zero bytes; no alternative alphabet/encoding exists.
  return bytes + (value.match(/^1*/)?.[0].length ?? 0) === 32;
}
function integerText(value: unknown, nonzero = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) invalid();
  const result = BigInt(value); if (result > U64_MAX || (nonzero && result === 0n)) invalid(); return result;
}
function request(value: unknown): Readonly<RunnerAssessmentRequest> {
  exact(value, ["version", "chain", "inputMint", "outputMint", "grossInputLamports", "slippageBps", "planDigest"]);
  if (value.version !== 1 || value.chain !== "solana" || value.inputMint !== WSOL
    || typeof value.outputMint !== "string" || !solanaAsset(value.outputMint) || value.outputMint === WSOL
    || !positive(value.slippageBps) || value.slippageBps > 5000 || !matches(value.planDigest, HEX)) invalid();
  integerText(value.grossInputLamports, true);
  return Object.freeze({ version: 1, chain: "solana", inputMint: WSOL, outputMint: value.outputMint,
    grossInputLamports: value.grossInputLamports as string, slippageBps: value.slippageBps, planDigest: value.planDigest });
}
export function runnerAssessmentRequestDigest(value: RunnerAssessmentRequest): string {
  return createHash("sha256").update(JSON.stringify([REQUEST_PURPOSE, request(value)]), "utf8").digest("hex");
}
function expected(value: RunnerAssessmentExpectedTarget): RunnerAssessmentExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...target(targetPart(value)), epoch: value.epoch, request: request(value.request) });
}
export function validateRunnerAssessmentNonce(value: unknown, expectedTarget: RunnerAssessmentExpectedTarget, now = Date.now()): RunnerAssessmentNonce {
  const pinned = expected(expectedTarget); exact(value, NONCE_KEYS);
  if (!Number.isFinite(now) || value.version !== 1 || value.purpose !== PURPOSE
    || value.audience !== `${pinned.frontendOrigin}/api${PATH}/query` || !matches(value.nonceId, UUID)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.runnerPublicKey !== pinned.runnerPublicKey
    || value.instanceId !== pinned.instanceId || value.epoch !== pinned.epoch
    || value.requestDigest !== runnerAssessmentRequestDigest(pinned.request) || !matches(value.nonce, HEX)) invalid();
  const issued = timestamp(value.issuedAt), expires = timestamp(value.expiresAt);
  if (issued > now + CLOCK_SKEW_MS || expires <= now || expires - issued !== 15_000) invalid();
  return Object.freeze({ ...value }) as unknown as RunnerAssessmentNonce;
}
export function runnerAssessmentNonceMessage(value: RunnerAssessmentNonce, expectedTarget: RunnerAssessmentExpectedTarget, now = Date.now()): string {
  const checked = validateRunnerAssessmentNonce(value, expectedTarget, now);
  return JSON.stringify(NONCE_KEYS.map((key) => checked[key]));
}
function hash(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}
function observed(value: unknown, start: bigint, end: bigint): void {
  const time = integerText(value, true); if (time < start || time > end) invalid();
}
function fee(value: unknown, pinned: RunnerAssessmentRequest): Readonly<RunnerAssessmentFee> {
  exact(value, ["source", "rateBps", "recipient", "grossInputLamports", "feeLamports", "netInputLamports", "policyDigest"]);
  if (value.source !== "backend_global_fee_config" || typeof value.rateBps !== "number" || !Number.isInteger(value.rateBps)
    || value.rateBps < 0 || value.rateBps > 10000 || typeof value.recipient !== "string"
    || (value.rateBps === 0 ? value.recipient !== "" : !solanaAsset(value.recipient))
    || value.grossInputLamports !== pinned.grossInputLamports
    || value.policyDigest !== hash(["balchemy.solana-fee-policy.v1", value.source, value.rateBps, value.recipient])) invalid();
  const gross = integerText(value.grossInputLamports, true), cost = integerText(value.feeLamports), net = integerText(value.netInputLamports, true);
  if (cost !== gross * BigInt(value.rateBps) / 10000n || cost + net !== gross) invalid();
  return Object.freeze({ ...value }) as unknown as Readonly<RunnerAssessmentFee>;
}
function quote(value: unknown, pinned: RunnerAssessmentRequest, cost: RunnerAssessmentFee, start: bigint, end: bigint): Readonly<RunnerAssessmentQuote> {
  exact(value, ["inputMint", "outputMint", "inAmount", "outAmount", "minOut", "slippageBps", "contextSlot", "observedAtMs"]);
  if (value.inputMint !== pinned.inputMint || value.outputMint !== pinned.outputMint
    || value.inAmount !== cost.netInputLamports || value.slippageBps !== pinned.slippageBps) invalid();
  const out = integerText(value.outAmount, true), minimum = integerText(value.minOut, true);
  if (minimum !== out * BigInt(10000 - pinned.slippageBps) / 10000n) invalid();
  integerText(value.contextSlot, true); observed(value.observedAtMs, start, end);
  return Object.freeze({ ...value }) as unknown as Readonly<RunnerAssessmentQuote>;
}
function pretrade(value: unknown, start: bigint, end: bigint): Readonly<RunnerAssessmentPretrade> {
  exact(value, ["verdict", "reasons", "rugcheckStatus", "rugcheckObservedAtMs", "mintStatus", "mintObservedAtMs", "mintContextSlot"]);
  if (!Array.isArray(value.reasons) || Object.getPrototypeOf(value.reasons) !== Array.prototype || value.reasons.length > PRETRADE_REASONS.length) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value.reasons);
  if (Reflect.ownKeys(value.reasons).length !== value.reasons.length + 1
    || Object.values(descriptors).some((part) => !("value" in part))) invalid();
  const reasons: string[] = [];
  for (let i = 0; i < value.reasons.length; i++) {
    const reason: unknown = descriptors[String(i)]?.value;
    if (typeof reason !== "string" || !PRETRADE_REASONS.includes(reason as typeof PRETRADE_REASONS[number]) || reasons.includes(reason)) invalid();
    reasons.push(reason);
  }
  if (reasons.some((reason, index) => index > 0
    && PRETRADE_REASONS.indexOf(reason as typeof PRETRADE_REASONS[number])
      <= PRETRADE_REASONS.indexOf(reasons[index - 1] as typeof PRETRADE_REASONS[number]))) invalid();
  const rugMissing = reasons.includes("signal_unavailable:rugcheck"), mintMissing = reasons.includes("signal_unavailable:helius");
  const rugRisk = reasons.includes("rugcheck_risks_present"), mintRisk = reasons.includes("mint_authority_present"), freeze = reasons.includes("freeze_authority_present");
  if (value.rugcheckStatus !== (rugMissing ? "unavailable" : "available") || value.mintStatus !== (mintMissing ? "unavailable" : "available")
    || (rugMissing && rugRisk) || (mintMissing && (mintRisk || freeze))
    || reasons.includes("high_risk_combined") !== (rugRisk && mintRisk)
    || value.verdict !== (rugRisk && mintRisk ? "block" : reasons.length > 0 ? "require_approval" : "allow")) invalid();
  observed(value.rugcheckObservedAtMs, start, end); observed(value.mintObservedAtMs, start, end);
  if (mintMissing) { if (value.mintContextSlot !== "") invalid(); } else integerText(value.mintContextSlot, true);
  return Object.freeze({ ...value, reasons: Object.freeze(reasons) }) as unknown as Readonly<RunnerAssessmentPretrade>;
}
function assessment(value: unknown, pinned: RunnerAssessmentExpectedTarget, now: number): Readonly<RunnerSolanaAssessment> {
  exact(value, ["version", "requestDigest", "planDigest", "inputMint", "outputMint", "grossInputLamports", "slippageBps",
    "startedAtMs", "completedAtMs", "expiresAtMs", "status", "reasonCode", "fee", "executionAvailable", "assessmentDigest"], ["quote", "pretrade"]);
  if (value.version !== 1 || value.requestDigest !== runnerAssessmentRequestDigest(pinned.request)
    || value.planDigest !== pinned.request.planDigest || value.inputMint !== pinned.request.inputMint
    || value.outputMint !== pinned.request.outputMint || value.grossInputLamports !== pinned.request.grossInputLamports
    || value.slippageBps !== pinned.request.slippageBps || value.executionAvailable !== false || !matches(value.assessmentDigest, HEX)) invalid();
  const start = integerText(value.startedAtMs, true), end = integerText(value.completedAtMs, true), expiry = integerText(value.expiresAtMs, true);
  if (!Number.isSafeInteger(now) || now < 0 || end < start || expiry !== start + 15000n || end >= expiry
    || end > BigInt(now + CLOCK_SKEW_MS) || BigInt(now) >= expiry) invalid();
  const cost = fee(value.fee, pinned.request);
  const route = value.quote === undefined ? undefined : quote(value.quote, pinned.request, cost, start, end);
  const safety = value.pretrade === undefined ? undefined : pretrade(value.pretrade, start, end);
  const complete = route !== undefined && safety?.rugcheckStatus === "available" && safety.mintStatus === "available";
  if (value.status === "complete") {
    if (!complete || value.reasonCode !== "" || end - start > 12000n) invalid();
  } else if (value.status === "unavailable") {
    if (value.reasonCode === "deadline_exceeded") {
      if (route !== undefined || safety !== undefined || end - start < 12000n) invalid();
    } else if (value.reasonCode === "quote_unavailable") {
      if (route !== undefined || end - start > 12000n) invalid();
    } else if (value.reasonCode === "pretrade_unavailable") {
      if (route === undefined || complete || end - start > 12000n) invalid();
    } else invalid();
  } else invalid();
  const computed = hash(["balchemy.solana-assessment.v1", value.requestDigest, value.planDigest, value.inputMint,
    value.outputMint, value.grossInputLamports, value.slippageBps, value.startedAtMs, value.completedAtMs,
    value.expiresAtMs, value.status, value.reasonCode,
    [cost.source, cost.rateBps, cost.recipient, cost.grossInputLamports, cost.feeLamports, cost.netInputLamports, cost.policyDigest],
    route ? [route.inputMint, route.outputMint, route.inAmount, route.outAmount, route.minOut, route.slippageBps, route.contextSlot, route.observedAtMs] : null,
    safety ? [safety.verdict, safety.reasons, safety.rugcheckStatus, safety.rugcheckObservedAtMs, safety.mintStatus, safety.mintObservedAtMs, safety.mintContextSlot] : null, false]);
  if (value.assessmentDigest !== computed) invalid();
  return Object.freeze({ ...value, fee: cost, ...(route ? { quote: route } : {}), ...(safety ? { pretrade: safety } : {}) }) as unknown as Readonly<RunnerSolanaAssessment>;
}
export function validateRunnerAssessmentResponse(value: unknown, expectedTarget: RunnerAssessmentExpectedTarget, now = Date.now()): RunnerAssessmentResponse {
  const pinned = expected(expectedTarget);
  exact(value, ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "completedAt", "assessment"]);
  if (!Number.isFinite(now) || value.version !== 1 || value.requestDigest !== runnerAssessmentRequestDigest(pinned.request)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId
    || value.epoch !== pinned.epoch || Math.abs(timestamp(value.completedAt) - now) > CLOCK_SKEW_MS) invalid();
  const result = Object.freeze({ ...value, assessment: assessment(value.assessment, pinned, now) }) as unknown as RunnerAssessmentResponse;
  if (integerText(result.assessment.completedAtMs) > BigInt(timestamp(result.completedAt))
    || BigInt(timestamp(result.completedAt)) >= integerText(result.assessment.expiresAtMs)
    || Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return result;
}
function waitFor<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); return operation(); }).then(
      (value) => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(cancelled()); else resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}
async function canonicalResponse(response: Response, signal: AbortSignal, path: string): Promise<Response> {
  const text = await waitFor(() => readBoundedResponseText(response, MAX_PAYLOAD_BYTES + MAX_ENVELOPE_BYTES, signal), signal);
  if (response.ok) {
    let decoded: unknown; try { decoded = JSON.parse(text) as unknown; } catch { return invalid(); }
    // HttpClient owns canonical failure mapping and its sanitized metadata.
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)
      && (decoded as Record<string, unknown>).success === false) {
      return new Response(text, { status: response.status, headers: response.headers });
    }
    exact(decoded, ["success", "data", "meta"], ["message"]);
    if (decoded.success !== true || (decoded.message !== undefined && (typeof decoded.message !== "string" || decoded.message.length > MAX_ENVELOPE_BYTES))) invalid();
    exact(decoded.meta, ["timestamp", "compatMode"], ["requestId", "correlationId", "path", "method"]);
    timestamp(decoded.meta.timestamp); if (decoded.meta.compatMode !== "canonical") invalid();
    for (const key of ["requestId", "correlationId", "path", "method"] as const) {
      const part = decoded.meta[key]; if (part !== undefined && (typeof part !== "string" || part.length > (key === "path" ? 512 : key === "method" ? 16 : 256))) invalid();
    }
    if ((decoded.meta.path !== undefined && decoded.meta.path !== path)
      || (decoded.meta.method !== undefined && decoded.meta.method !== "POST")) invalid();
    if (Buffer.byteLength(JSON.stringify(decoded.data), "utf8") > MAX_PAYLOAD_BYTES
      || Buffer.byteLength(JSON.stringify({ ...decoded, data: null }), "utf8") > MAX_ENVELOPE_BYTES) invalid();
  }
  return new Response(text, { status: response.status, headers: response.headers });
}
export class RunnerAssessmentClient {
  private readonly pinned: RunnerAssessmentTarget;
  private readonly signer: RunnerAssessmentSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerAssessmentClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = target(targetPart(config));
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }
  /** A single bounded attempt; the caller still enforces its current runner lease. */
  async query(input: RunnerAssessmentRequest, epoch: number, callerSignal?: AbortSignal): Promise<RunnerAssessmentResponse> {
    const operation = expected({ ...this.pinned, epoch, request: input });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    const http = new HttpClient({ baseUrl: `${this.pinned.frontendOrigin}/api`, timeoutMs: this.timeoutMs, retry: { maxAttempts: 1 },
      fetchFn: async (url, init) => {
        const abort = new AbortController(); const relay = () => abort.abort();
        const sources = [scope.signal, init?.signal].filter((item): item is AbortSignal => Boolean(item));
        for (const signal of sources) { signal.addEventListener("abort", relay, { once: true }); if (signal.aborted) abort.abort(); }
        try {
          const response = await waitFor(() => Promise.resolve(this.transport(url, { ...init, signal: abort.signal, credentials: "omit", redirect: "error",
            headers: { ...init?.headers, "Cache-Control": "no-store" } })).then((received) => {
            if (abort.signal.aborted) { void received.body?.cancel().catch(() => undefined); throw cancelled(); } return received;
          }), abort.signal);
          return await canonicalResponse(response, abort.signal, new URL(String(url)).pathname);
        } finally { for (const signal of sources) signal.removeEventListener("abort", relay); }
      },
    });
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerAssessmentRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:assessment-nonce" }), scope.signal);
      const nonce = validateRunnerAssessmentNonce(data, operation);
      const signing = new AbortController(); const abortSigning = () => signing.abort();
      scope.signal.addEventListener("abort", abortSigning, { once: true }); if (scope.signal.aborted) signing.abort();
      const expires = setTimeout(abortSigning, Math.max(1, timestamp(nonce.expiresAt) - Date.now()));
      let signature: string;
      try { signature = await waitFor(() => this.signer(nonce, operation), signing.signal); }
      catch { if (scope.signal.aborted) throw cancelled(); return invalid(); }
      finally { clearTimeout(expires); scope.signal.removeEventListener("abort", abortSigning); }
      validateRunnerAssessmentNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/query`, { nonceId: nonce.nonceId, signature,
        epoch: operation.epoch, request: operation.request }, { kind: "side_effecting", operation: "local-agent:assessment-query" }), scope.signal);
      return validateRunnerAssessmentResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
