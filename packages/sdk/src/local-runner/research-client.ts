import { createHash } from "node:crypto";
import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText, redactSecretLikeText } from "../utils/redaction";
import type { RunnerRuntimeTarget } from "./runtime-client";

export type RunnerResearchTarget = RunnerRuntimeTarget;
export type RunnerResearchChain = "solana" | "base";
export type RunnerResearchSignal = "launches" | "trending" | "social" | "liquidity";
/** Closed public-market requests. Private prompts, rules and URLs are not inputs. */
export type RunnerResearchRequest =
  | { kind: "market_brief"; chain: RunnerResearchChain; limit: number; timeWindowMinutes: number; signals: readonly RunnerResearchSignal[] }
  | { kind: "candidate_report"; chain: RunnerResearchChain; assetId: string; includeX: boolean; includeOnchain: boolean }
  | { kind: "risk_report"; chain: RunnerResearchChain; assetId: string };
export type RunnerResearchExpectedTarget = RunnerResearchTarget & { epoch: number; request: RunnerResearchRequest };
export interface RunnerResearchNonce {
  version: 1; purpose: "balchemy.local-agent.research.query.v1"; audience: string; nonceId: string;
  agentId: string; bindingDigest: string; runnerPublicKey: string; instanceId: string; epoch: number;
  requestDigest: string; nonce: string; issuedAt: string; expiresAt: string;
}
export interface RunnerResearchFailureDetails {
  layer?: "transport" | "http_ingress" | "mcp_ingress" | "mcp_scope" | "research_budget" | "provider" | "policy" | "unknown";
  source?: string; retryable?: boolean; retryAfterSeconds?: number; degraded?: boolean; dataAvailable?: boolean;
}
export type RunnerResearchFailureStatus = "tool_not_found" | "policy_denied" | "scope_denied" | "quota_blocked"
  | "concurrency_rejected" | "timeout" | "tool_error" | "internal_error";
/** ok describes the tool call, not evidence usability or execution authority.
 * Source health, missing evidence and holds remain in the unchanged report text. */
export type RunnerResearchResult =
  | { text: string; ok: true; status: "ok" }
  | { text: string; ok: false; status: RunnerResearchFailureStatus;
      error: { code: string; message: string; details?: RunnerResearchFailureDetails } };
export interface RunnerResearchResponse {
  version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string;
  epoch: number; completedAt: string; result: RunnerResearchResult;
}
/** Sign only runnerResearchNonceMessage after independently checking this context. */
export type RunnerResearchSigner = (nonce: Readonly<RunnerResearchNonce>, expected: RunnerResearchExpectedTarget) => string | Promise<string>;
export interface RunnerResearchClientConfig extends RunnerResearchTarget {
  apiBaseUrl: string; signer: RunnerResearchSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/research";
const PURPOSE = "balchemy.local-agent.research.query.v1";
const REQUEST_PURPOSE = "balchemy.local-agent.research.request.v1";
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_ENVELOPE_BYTES = 4096;
const CLOCK_SKEW_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const TARGET_KEYS = ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "instanceId"] as const;
const NONCE_KEYS = ["version", "purpose", "audience", "nonceId", "agentId", "bindingDigest", "runnerPublicKey",
  "instanceId", "epoch", "requestDigest", "nonce", "issuedAt", "expiresAt"] as const;
const SIGNALS = ["launches", "trending", "social", "liquidity"] as const;
const FAILURE_STATUSES = ["tool_not_found", "policy_denied", "scope_denied", "quota_blocked", "concurrency_rejected", "timeout", "tool_error", "internal_error"] as const;
const LAYERS = ["transport", "http_ingress", "mcp_ingress", "mcp_scope", "research_budget", "provider", "policy", "unknown"] as const;

function invalid(): never {
  throw new AgentSdkError({ code: "invalid_response", message: "Invalid local-agent research protocol", details: { retryable: false } });
}
function cancelled(): AgentSdkError {
  return new AgentSdkError({ code: "network_error", message: "Local-agent research deadline or cancellation reached",
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
function target(value: unknown): RunnerResearchTarget {
  exact(value, TARGET_KEYS);
  if (typeof value.frontendOrigin !== "string" || !matches(value.agentId, UUID) || !matches(value.instanceId, UUID)
    || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32)) invalid();
  try {
    const url = new URL(value.frontendOrigin);
    if (url.origin !== value.frontendOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  } catch { invalid(); }
  return Object.freeze({ ...value }) as unknown as RunnerResearchTarget;
}
function targetPart(value: RunnerResearchTarget): RunnerResearchTarget {
  return Object.fromEntries(TARGET_KEYS.map((key) => [key, value[key]])) as unknown as RunnerResearchTarget;
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
function request(value: unknown): RunnerResearchRequest {
  exact(value, ["kind"], ["chain", "limit", "timeWindowMinutes", "signals", "assetId", "includeX", "includeOnchain"]);
  if (value.chain !== "solana" && value.chain !== "base") invalid();
  const chain = value.chain;
  if (value.kind === "market_brief") {
    exact(value, ["kind", "chain", "limit", "timeWindowMinutes", "signals"]);
    if (!positive(value.limit) || value.limit > 20 || !positive(value.timeWindowMinutes) || value.timeWindowMinutes > 1440
      || !Array.isArray(value.signals) || Object.getPrototypeOf(value.signals) !== Array.prototype || value.signals.length > 4) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value.signals);
    if (Reflect.ownKeys(value.signals).length !== value.signals.length + 1
      || Object.values(descriptors).some((part) => !("value" in part))) invalid();
    const signals: RunnerResearchSignal[] = [];
    for (let index = 0; index < value.signals.length; index++) {
      const signal: unknown = descriptors[String(index)]?.value;
      if (!SIGNALS.includes(signal as RunnerResearchSignal) || signals.includes(signal as RunnerResearchSignal)) invalid();
      signals.push(signal as RunnerResearchSignal);
    }
    return Object.freeze({ kind: "market_brief", chain, limit: value.limit, timeWindowMinutes: value.timeWindowMinutes, signals: Object.freeze(signals) });
  }
  if (value.kind !== "candidate_report" && value.kind !== "risk_report") invalid();
  exact(value, ["kind", "chain", "assetId", ...(value.kind === "candidate_report" ? ["includeX", "includeOnchain"] : [])]);
  if (typeof value.assetId !== "string" || (chain === "base" ? !/^0x[0-9a-f]{40}$/.test(value.assetId) : !solanaAsset(value.assetId))) invalid();
  if (value.kind === "risk_report") return Object.freeze({ kind: "risk_report", chain, assetId: value.assetId });
  if (typeof value.includeX !== "boolean" || typeof value.includeOnchain !== "boolean") invalid();
  return Object.freeze({ kind: "candidate_report", chain, assetId: value.assetId, includeX: value.includeX, includeOnchain: value.includeOnchain });
}
export function runnerResearchRequestDigest(value: RunnerResearchRequest): string {
  return createHash("sha256").update(JSON.stringify([REQUEST_PURPOSE, request(value)]), "utf8").digest("hex");
}
function expected(value: RunnerResearchExpectedTarget): RunnerResearchExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...target(targetPart(value)), epoch: value.epoch, request: request(value.request) });
}
export function validateRunnerResearchNonce(value: unknown, expectedTarget: RunnerResearchExpectedTarget, now = Date.now()): RunnerResearchNonce {
  const pinned = expected(expectedTarget); exact(value, NONCE_KEYS);
  if (!Number.isFinite(now) || value.version !== 1 || value.purpose !== PURPOSE
    || value.audience !== `${pinned.frontendOrigin}/api${PATH}/query` || !matches(value.nonceId, UUID)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.runnerPublicKey !== pinned.runnerPublicKey
    || value.instanceId !== pinned.instanceId || value.epoch !== pinned.epoch
    || value.requestDigest !== runnerResearchRequestDigest(pinned.request) || !matches(value.nonce, HEX)) invalid();
  const issued = timestamp(value.issuedAt), expires = timestamp(value.expiresAt);
  if (issued > now + CLOCK_SKEW_MS || expires <= now || expires - issued !== 15_000) invalid();
  return Object.freeze({ ...value }) as unknown as RunnerResearchNonce;
}
export function runnerResearchNonceMessage(value: RunnerResearchNonce, expectedTarget: RunnerResearchExpectedTarget, now = Date.now()): string {
  const checked = validateRunnerResearchNonce(value, expectedTarget, now);
  return JSON.stringify(NONCE_KEYS.map((key) => checked[key]));
}
function failureDetails(value: unknown): RunnerResearchFailureDetails {
  exact(value, [], ["layer", "source", "retryable", "retryAfterSeconds", "degraded", "dataAvailable"]);
  if ((value.layer !== undefined && !LAYERS.includes(value.layer as typeof LAYERS[number]))
    || (value.source !== undefined && !matches(value.source, /^[a-zA-Z0-9_.-]{1,64}$/))
    || (value.retryAfterSeconds !== undefined && (typeof value.retryAfterSeconds !== "number" || !Number.isSafeInteger(value.retryAfterSeconds)
      || value.retryAfterSeconds < 0 || value.retryAfterSeconds > 86_400))) invalid();
  for (const key of ["retryable", "degraded", "dataAvailable"]) if (value[key] !== undefined && typeof value[key] !== "boolean") invalid();
  return Object.freeze({ ...value, ...(typeof value.source === "string" ? { source: redactSecretLikeText(value.source) } : {}) }) as RunnerResearchFailureDetails;
}
function result(value: unknown): RunnerResearchResult {
  exact(value, ["text", "ok", "status"], ["error"]);
  if (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > MAX_PAYLOAD_BYTES) invalid();
  if (value.ok === true) {
    exact(value, ["text", "ok", "status"]); if (value.status !== "ok") invalid();
    return Object.freeze({ text: value.text, ok: true, status: "ok" });
  }
  if (value.ok !== false || !FAILURE_STATUSES.includes(value.status as RunnerResearchFailureStatus)) invalid();
  exact(value.error, ["code", "message"], ["details"]);
  if (!matches(value.error.code, /^[A-Z0-9_:-]{1,96}$/) || typeof value.error.message !== "string" || value.error.message.length > 500) invalid();
  const error = Object.freeze({ code: value.error.code, message: redactSecretLikeText(value.error.message),
    ...(value.error.details !== undefined ? { details: failureDetails(value.error.details) } : {}) });
  return Object.freeze({ text: redactSecretLikeText(value.text), ok: false, status: value.status as RunnerResearchFailureStatus, error });
}
export function validateRunnerResearchResponse(value: unknown, expectedTarget: RunnerResearchExpectedTarget, now = Date.now()): RunnerResearchResponse {
  const pinned = expected(expectedTarget);
  exact(value, ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "completedAt", "result"]);
  if (!Number.isFinite(now) || value.version !== 1 || value.requestDigest !== runnerResearchRequestDigest(pinned.request)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId
    || value.epoch !== pinned.epoch || Math.abs(timestamp(value.completedAt) - now) > CLOCK_SKEW_MS) invalid();
  const response = Object.freeze({ ...value, result: result(value.result) }) as unknown as RunnerResearchResponse;
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_PAYLOAD_BYTES) invalid();
  return response;
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
export class RunnerResearchClient {
  private readonly pinned: RunnerResearchTarget;
  private readonly signer: RunnerResearchSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerResearchClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = target(targetPart(config));
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }
  /** A single bounded attempt; the caller still enforces its current runner lease. */
  async query(input: RunnerResearchRequest, epoch: number, callerSignal?: AbortSignal): Promise<RunnerResearchResponse> {
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
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerResearchRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:research-nonce" }), scope.signal);
      const nonce = validateRunnerResearchNonce(data, operation);
      const signing = new AbortController(); const abortSigning = () => signing.abort();
      scope.signal.addEventListener("abort", abortSigning, { once: true }); if (scope.signal.aborted) signing.abort();
      const expires = setTimeout(abortSigning, Math.max(1, timestamp(nonce.expiresAt) - Date.now()));
      let signature: string;
      try { signature = await waitFor(() => this.signer(nonce, operation), signing.signal); }
      catch { if (scope.signal.aborted) throw cancelled(); return invalid(); }
      finally { clearTimeout(expires); scope.signal.removeEventListener("abort", abortSigning); }
      validateRunnerResearchNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/query`, { nonceId: nonce.nonceId, signature,
        epoch: operation.epoch, request: operation.request }, { kind: "side_effecting", operation: "local-agent:research-query" }), scope.signal);
      return validateRunnerResearchResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
