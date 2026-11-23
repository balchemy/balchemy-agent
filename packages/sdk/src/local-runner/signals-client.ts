import { createHash } from "node:crypto";
import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";
import type { RunnerRuntimeTarget } from "./runtime-client";

export type RunnerSignalsTarget = RunnerRuntimeTarget;
/** Poll returns data only. ACK is a separate explicit call after local durable commit. */
export type RunnerSignalsRequest = { kind: "poll" } | { kind: "ack"; eventId: string; eventDigest: string };
export type RunnerSignalsExpectedTarget = RunnerSignalsTarget & { epoch: number; request: RunnerSignalsRequest };
export interface RunnerSignalsNonce {
  version: 1; purpose: "balchemy.local-agent.signals.query.v1"; audience: string; nonceId: string;
  agentId: string; bindingDigest: string; runnerPublicKey: string; instanceId: string; epoch: number;
  requestDigest: string; nonce: string; issuedAt: string; expiresAt: string;
}
/** Signal platforms this SDK parses. `launchpad` (K4, 19 Nov 2026): a public on-chain launch observation from a launchpad the
 * agent subscribed to (sourceId is the catalog source id, sourceRevision the subscription revision). It is not a buy signal. */
export const RUNNER_SIGNAL_PLATFORMS = ["telegram", "discord", "launchpad"] as const;
export type RunnerSignalPlatform = typeof RUNNER_SIGNAL_PLATFORMS[number];
export interface RunnerSignalProjection {
  version: 1; eventId: string; agentId: string; bindingDigest: string; sourceId: string;
  sourceRevision: number; attributionKey: string; platform: RunnerSignalPlatform; chain: "solana";
  assetId: string; observedAt: string; recordedAt: string; sourceHealthFreshUntil: string;
}
export interface RunnerSignal extends RunnerSignalProjection { eventDigest: string }
/** A delivered row of a platform this SDK does not know (a newer server): its identity only, so the runner can ACK it without acting
 * (one unknown row never invalidates the whole page). Its digest re-derives over the same closed projection. */
export interface RunnerIgnoredSignal { eventId: string; eventDigest: string }
export type RunnerSignalsResult = { kind: "poll"; signals: readonly RunnerSignal[]; ignored?: readonly RunnerIgnoredSignal[] }
  | { kind: "ack"; eventId: string; eventDigest: string; receivedAt: string };
export interface RunnerSignalsResponse {
  version: 1; requestDigest: string; agentId: string; bindingDigest: string; instanceId: string;
  epoch: number; completedAt: string; result: RunnerSignalsResult;
}
/** Sign only runnerSignalsNonceMessage after independently checking this context. */
export type RunnerSignalsSigner = (nonce: Readonly<RunnerSignalsNonce>, expected: RunnerSignalsExpectedTarget) => string | Promise<string>;
export interface RunnerSignalsClientConfig extends RunnerSignalsTarget {
  apiBaseUrl: string; signer: RunnerSignalsSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/signals";
const PURPOSE = "balchemy.local-agent.signals.query.v1";
const REQUEST_PURPOSE = "balchemy.local-agent.signals.request.v1";
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 4096;
const CLOCK_SKEW_MS = 5000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const TARGET_KEYS = ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "instanceId"] as const;
const NONCE_KEYS = ["version", "purpose", "audience", "nonceId", "agentId", "bindingDigest", "runnerPublicKey",
  "instanceId", "epoch", "requestDigest", "nonce", "issuedAt", "expiresAt"] as const;
const EVENT_ID = /^lsi_[0-9a-f]{64}$/;
const EVENT_PURPOSE = "balchemy.local-agent.signal.v1";
const PROJECTION_KEYS = ["version", "eventId", "agentId", "bindingDigest", "sourceId", "sourceRevision", "attributionKey",
  "platform", "chain", "assetId", "observedAt", "recordedAt", "sourceHealthFreshUntil"] as const;

function invalid(): never {
  throw new AgentSdkError({ code: "invalid_response", message: "Invalid local-agent signals protocol", details: { retryable: false } });
}
function cancelled(): AgentSdkError {
  return new AgentSdkError({ code: "network_error", message: "Local-agent signals deadline or cancellation reached",
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
function target(value: unknown): RunnerSignalsTarget {
  exact(value, TARGET_KEYS);
  if (typeof value.frontendOrigin !== "string" || !matches(value.agentId, UUID) || !matches(value.instanceId, UUID)
    || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32)) invalid();
  try {
    const url = new URL(value.frontendOrigin);
    if (url.origin !== value.frontendOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  } catch { invalid(); }
  return Object.freeze({ ...value }) as unknown as RunnerSignalsTarget;
}
function targetPart(value: RunnerSignalsTarget): RunnerSignalsTarget {
  return Object.fromEntries(TARGET_KEYS.map((key) => [key, value[key]])) as unknown as RunnerSignalsTarget;
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
function request(value: unknown): RunnerSignalsRequest {
  exact(value, ["kind"], ["eventId", "eventDigest"]);
  if (value.kind === "poll") { exact(value, ["kind"]); return Object.freeze({ kind: "poll" }); }
  exact(value, ["kind", "eventId", "eventDigest"]);
  if (value.kind !== "ack" || !matches(value.eventId, EVENT_ID) || !matches(value.eventDigest, HEX)) invalid();
  return Object.freeze({ kind: "ack", eventId: value.eventId, eventDigest: value.eventDigest });
}
export function runnerSignalsRequestDigest(value: RunnerSignalsRequest): string {
  const checked = request(value);
  const parts = checked.kind === "poll" ? [REQUEST_PURPOSE, checked.kind]
    : [REQUEST_PURPOSE, checked.kind, checked.eventId, checked.eventDigest];
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}
/** A platform slug a newer server may send (same shape as a launchpad id). */
const PLATFORM_SLUG = /^[a-z][a-z0-9_]{1,31}$/;
function knownPlatform(value: unknown): value is RunnerSignalPlatform {
  return typeof value === "string" && (RUNNER_SIGNAL_PLATFORMS as readonly string[]).includes(value);
}
function projection(value: unknown, platform: (value: unknown) => boolean = knownPlatform): RunnerSignalProjection {
  exact(value, PROJECTION_KEYS);
  if (value.version !== 1 || !matches(value.eventId, EVENT_ID) || !matches(value.agentId, UUID)
    || !matches(value.bindingDigest, HEX) || !matches(value.sourceId, /^src_[0-9a-f]{24}$/)
    || !positive(value.sourceRevision) || !matches(value.attributionKey, /^sig_[0-9a-f]{32}$/)
    || !platform(value.platform) || value.chain !== "solana"
    || typeof value.assetId !== "string" || !solanaAsset(value.assetId)) invalid();
  const observed = timestamp(value.observedAt), recorded = timestamp(value.recordedAt), health = timestamp(value.sourceHealthFreshUntil);
  if (observed > recorded + 30_000 || recorded - observed > 300_000 || health <= recorded || health > recorded + 300_000) invalid();
  return Object.freeze({ ...value }) as unknown as RunnerSignalProjection;
}
/** Hash the closed event projection, without its eventDigest field. */
export function runnerSignalEventDigest(value: RunnerSignalProjection): string {
  return projectionDigest(projection(value));
}
function projectionDigest(checked: RunnerSignalProjection): string {
  return createHash("sha256").update(JSON.stringify([EVENT_PURPOSE, ...PROJECTION_KEYS.map((key) => checked[key])]), "utf8").digest("hex");
}
function checkedSignal(value: unknown, scope: Pick<RunnerSignalsTarget, "agentId" | "bindingDigest">, completedAt: string,
  platform: (value: unknown) => boolean): RunnerSignal {
  exact(scope, ["agentId", "bindingDigest"]);
  if (!matches(scope.agentId, UUID) || !matches(scope.bindingDigest, HEX)) invalid();
  const completed = timestamp(completedAt);
  exact(value, [...PROJECTION_KEYS, "eventDigest"]);
  const checked = projection(Object.fromEntries(PROJECTION_KEYS.map((key) => [key, value[key]])), platform);
  if (checked.agentId !== scope.agentId || checked.bindingDigest !== scope.bindingDigest
    || timestamp(checked.recordedAt) > completed + 30_000 || timestamp(checked.observedAt) > completed + 30_000
    || value.eventDigest !== projectionDigest(checked)) invalid();
  // Historical source health remains historical. This receipt grants no execution authority.
  return Object.freeze({ ...checked, eventDigest: value.eventDigest }) as RunnerSignal;
}
export function validateRunnerSignal(value: unknown, scope: Pick<RunnerSignalsTarget, "agentId" | "bindingDigest">, completedAt: string): RunnerSignal {
  return checkedSignal(value, scope, completedAt, knownPlatform);
}
/** True when a delivered row names a well-formed platform slug this SDK does not know. */
function unknownPlatform(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const platform = Object.getOwnPropertyDescriptor(value, "platform");
  return Boolean(platform && "value" in platform && typeof platform.value === "string" && PLATFORM_SLUG.test(platform.value)
    && !knownPlatform(platform.value));
}
function expected(value: RunnerSignalsExpectedTarget): RunnerSignalsExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...target(targetPart(value)), epoch: value.epoch, request: request(value.request) });
}
export function validateRunnerSignalsNonce(value: unknown, expectedTarget: RunnerSignalsExpectedTarget, now = Date.now()): RunnerSignalsNonce {
  const pinned = expected(expectedTarget); exact(value, NONCE_KEYS);
  if (!Number.isFinite(now) || value.version !== 1 || value.purpose !== PURPOSE
    || value.audience !== `${pinned.frontendOrigin}/api${PATH}/query` || !matches(value.nonceId, UUID)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.runnerPublicKey !== pinned.runnerPublicKey
    || value.instanceId !== pinned.instanceId || value.epoch !== pinned.epoch
    || value.requestDigest !== runnerSignalsRequestDigest(pinned.request) || !matches(value.nonce, HEX)) invalid();
  const issued = timestamp(value.issuedAt), expires = timestamp(value.expiresAt);
  if (issued > now + CLOCK_SKEW_MS || expires <= now || expires - issued !== 15_000) invalid();
  return Object.freeze({ ...value }) as unknown as RunnerSignalsNonce;
}
export function runnerSignalsNonceMessage(value: RunnerSignalsNonce, expectedTarget: RunnerSignalsExpectedTarget, now = Date.now()): string {
  const checked = validateRunnerSignalsNonce(value, expectedTarget, now);
  return JSON.stringify(NONCE_KEYS.map((key) => checked[key]));
}
function result(value: unknown, operation: RunnerSignalsExpectedTarget, completedAt: string): RunnerSignalsResult {
  exact(value, ["kind"], ["signals", "eventId", "eventDigest", "receivedAt"]);
  if (operation.request.kind === "ack") {
    exact(value, ["kind", "eventId", "eventDigest", "receivedAt"]);
    if (value.kind !== "ack" || value.eventId !== operation.request.eventId || value.eventDigest !== operation.request.eventDigest
      || timestamp(value.receivedAt) > timestamp(completedAt) + CLOCK_SKEW_MS) invalid();
    return Object.freeze({ kind: "ack", eventId: value.eventId, eventDigest: value.eventDigest, receivedAt: value.receivedAt }) as RunnerSignalsResult;
  }
  exact(value, ["kind", "signals"]);
  if (value.kind !== "poll" || !Array.isArray(value.signals) || Object.getPrototypeOf(value.signals) !== Array.prototype || value.signals.length > 16) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value.signals);
  if (Reflect.ownKeys(value.signals).length !== value.signals.length + 1
    || Object.values(descriptors).some((part) => !("value" in part))) invalid();
  const signals: RunnerSignal[] = [], ignored: RunnerIgnoredSignal[] = [], ids = new Set<string>();
  const scope = { agentId: operation.agentId, bindingDigest: operation.bindingDigest };
  for (let index = 0; index < value.signals.length; index++) {
    const field = descriptors[String(index)]; if (!field?.enumerable) invalid();
    // A row of a platform this SDK does not know is checked whole (digest, scope, times) and returned only as an id to ACK.
    if (unknownPlatform(field.value)) {
      const row = checkedSignal(field.value, scope, completedAt, () => true);
      if (ids.has(row.eventId)) invalid(); ids.add(row.eventId);
      ignored.push(Object.freeze({ eventId: row.eventId, eventDigest: row.eventDigest }));
      continue;
    }
    const signal = validateRunnerSignal(field.value, scope, completedAt);
    if (ids.has(signal.eventId)) invalid(); ids.add(signal.eventId); signals.push(signal);
  }
  return Object.freeze({ kind: "poll", signals: Object.freeze(signals), ...(ignored.length ? { ignored: Object.freeze(ignored) } : {}) });
}
export function validateRunnerSignalsResponse(value: unknown, expectedTarget: RunnerSignalsExpectedTarget, now = Date.now()): RunnerSignalsResponse {
  const pinned = expected(expectedTarget);
  exact(value, ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "completedAt", "result"]);
  if (!Number.isFinite(now) || value.version !== 1 || value.requestDigest !== runnerSignalsRequestDigest(pinned.request)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId
    || value.epoch !== pinned.epoch || Math.abs(timestamp(value.completedAt) - now) > CLOCK_SKEW_MS) invalid();
  const response = Object.freeze({ ...value, result: result(value.result, pinned, value.completedAt as string) }) as unknown as RunnerSignalsResponse;
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
export class RunnerSignalsClient {
  private readonly pinned: RunnerSignalsTarget;
  private readonly signer: RunnerSignalsSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerSignalsClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = target(targetPart(config));
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 20_000; this.transport = config.fetchFn ?? fetch;
  }
  /** One signed attempt. Enforce the current lease; poll never performs an ACK. */
  async query(input: RunnerSignalsRequest, epoch: number, callerSignal?: AbortSignal): Promise<RunnerSignalsResponse> {
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
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerSignalsRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:signals-nonce" }), scope.signal);
      const nonce = validateRunnerSignalsNonce(data, operation);
      const signing = new AbortController(); const abortSigning = () => signing.abort();
      scope.signal.addEventListener("abort", abortSigning, { once: true }); if (scope.signal.aborted) signing.abort();
      const expires = setTimeout(abortSigning, Math.max(1, timestamp(nonce.expiresAt) - Date.now()));
      let signature: string;
      try { signature = await waitFor(() => this.signer(nonce, operation), signing.signal); }
      catch { if (scope.signal.aborted) throw cancelled(); return invalid(); }
      finally { clearTimeout(expires); scope.signal.removeEventListener("abort", abortSigning); }
      validateRunnerSignalsNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/query`, { nonceId: nonce.nonceId, signature,
        epoch: operation.epoch, request: operation.request }, { kind: "side_effecting", operation: "local-agent:signals-query" }), scope.signal);
      return validateRunnerSignalsResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
