import { createHash } from "node:crypto";
import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";
import type { RunnerRuntimeTarget } from "./runtime-client";

/** Internal helpers shared by fixed-purpose runner proof clients (not exported from the SDK index). */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const HEX = /^[0-9a-f]{64}$/;
export const TARGET_KEYS = ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "instanceId"] as const;
export const NONCE_KEYS = ["version", "purpose", "audience", "nonceId", "agentId", "bindingDigest", "runnerPublicKey",
  "instanceId", "epoch", "requestDigest", "nonce", "issuedAt", "expiresAt"] as const;
export const CLOCK_SKEW_MS = 5000;
export const U64_MAX = (1n << 64n) - 1n;
export const WSOL = "So11111111111111111111111111111111111111112";
const MAX_ENVELOPE_BYTES = 4096;

/** Runner nonce for a fixed purpose; signature bytes are UTF-8 JSON.stringify(NONCE_KEYS values in order). */
export interface RunnerProofNonce<P extends string> {
  version: 1; purpose: P; audience: string; nonceId: string; agentId: string; bindingDigest: string; runnerPublicKey: string;
  instanceId: string; epoch: number; requestDigest: string; nonce: string; issuedAt: string; expiresAt: string;
}

export function invalidFor(label: string): () => never {
  return () => { throw new AgentSdkError({ code: "invalid_response", message: `Invalid local-agent ${label} protocol`, details: { retryable: false } }); };
}
export function cancelledFor(label: string): () => AgentSdkError {
  return () => new AgentSdkError({ code: "network_error", message: `Local-agent ${label} deadline or cancellation reached`,
    details: { layer: "transport", code: "CLIENT_CANCELLED", retryable: false } });
}
/** Assertion functions need an explicit annotation at every call site: `const exact: ExactFn = exactWith(invalid)`. */
export type ExactFn = (value: unknown, required: readonly string[], optional?: readonly string[]) => asserts value is Record<string, unknown>;
export function exactWith(invalid: () => never): ExactFn {
  return function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (!required.every((key) => Object.hasOwn(descriptors, key))
      || Reflect.ownKeys(value).some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
      || Object.values(descriptors).some((descriptor) => !("value" in descriptor) || !descriptor.enumerable)) invalid();
  };
}
export function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
export function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function base64(value: unknown, length: number): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const bytes = Buffer.from(value, "base64"); return bytes.length === length && bytes.toString("base64") === value;
}
export function sha256(value: readonly unknown[]): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Canonical base58 decode (no alternative spelling); null when not canonical. */
export function base58Decode(value: string): Uint8Array | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value) || value.length > 128) return null;
  let integer = 0n;
  for (const character of value) integer = integer * 58n + BigInt(ALPHABET.indexOf(character));
  const body: number[] = []; for (let remaining = integer; remaining > 0n; remaining >>= 8n) body.unshift(Number(remaining & 0xffn));
  const zeros = value.match(/^1*/)?.[0].length ?? 0;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}
export function base58Encode(bytes: Uint8Array): string {
  let integer = 0n; for (const byte of bytes) integer = (integer << 8n) + BigInt(byte);
  let out = ""; while (integer > 0n) { out = ALPHABET[Number(integer % 58n)] + out; integer /= 58n; }
  for (const byte of bytes) { if (byte !== 0) break; out = `1${out}`; }
  return out;
}
export function solanaAddress(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) return false;
  const bytes = base58Decode(value); return bytes !== null && bytes.length === 32 && base58Encode(bytes) === value;
}
export function timestampWith(invalid: () => never) {
  return (value: unknown): number => {
    if (typeof value !== "string" || value.length !== 24) invalid();
    const time = Date.parse(value as string); if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid(); return time;
  };
}
export function integerTextWith(invalid: () => never) {
  return (value: unknown, minimum = 0n, maximum = U64_MAX): bigint => {
    if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) invalid();
    const result = BigInt(value as string); if (result < minimum || result > maximum) invalid(); return result;
  };
}
export function pinTarget(value: unknown, invalid: () => never): RunnerRuntimeTarget {
  const exact: ExactFn = exactWith(invalid); exact(value, TARGET_KEYS);
  if (typeof value.frontendOrigin !== "string" || !matches(value.agentId, UUID) || !matches(value.instanceId, UUID)
    || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32)) invalid();
  try {
    const url = new URL(value.frontendOrigin as string);
    if (url.origin !== value.frontendOrigin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  } catch { invalid(); }
  return Object.freeze({ ...value }) as unknown as RunnerRuntimeTarget;
}
export function targetPart(value: RunnerRuntimeTarget): RunnerRuntimeTarget {
  return Object.fromEntries(TARGET_KEYS.map((key) => [key, value[key]])) as unknown as RunnerRuntimeTarget;
}
/** Validates the fixed-purpose nonce against the pinned target/epoch/request digest and a 15s window. */
export function validateProofNonce<P extends string>(value: unknown, expected: RunnerRuntimeTarget & { epoch: number }, purpose: P, route: string,
  requestDigest: string, now: number, invalid: () => never): RunnerProofNonce<P> {
  const exact: ExactFn = exactWith(invalid); const timestamp = timestampWith(invalid); exact(value, NONCE_KEYS);
  if (!Number.isFinite(now) || value.version !== 1 || value.purpose !== purpose
    || value.audience !== `${expected.frontendOrigin}/api/nest/local-agents/${route}` || !matches(value.nonceId, UUID)
    || value.agentId !== expected.agentId || value.bindingDigest !== expected.bindingDigest || value.runnerPublicKey !== expected.runnerPublicKey
    || value.instanceId !== expected.instanceId || value.epoch !== expected.epoch || value.requestDigest !== requestDigest || !matches(value.nonce, HEX)) invalid();
  const issued = timestamp(value.issuedAt), expires = timestamp(value.expiresAt);
  if (issued > now + CLOCK_SKEW_MS || expires <= now || expires - issued !== 15_000) invalid();
  return Object.freeze({ ...value }) as unknown as RunnerProofNonce<P>;
}
export function proofNonceMessage<P extends string>(nonce: RunnerProofNonce<P>): string { return JSON.stringify(NONCE_KEYS.map((key) => nonce[key])); }

export function waitFor<T>(operation: () => T | PromiseLike<T>, signal: AbortSignal, cancelled: () => AgentSdkError): Promise<T> {
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
async function canonicalResponse(response: Response, signal: AbortSignal, path: string, maxPayloadBytes: number,
  invalid: () => never, cancelled: () => AgentSdkError): Promise<Response> {
  const exact: ExactFn = exactWith(invalid); const timestamp = timestampWith(invalid);
  const text = await waitFor(() => readBoundedResponseText(response, maxPayloadBytes + MAX_ENVELOPE_BYTES, signal), signal, cancelled);
  if (response.ok) {
    let decoded: unknown; try { decoded = JSON.parse(text) as unknown; } catch { return invalid(); }
    // HttpClient owns canonical failure mapping and its sanitized metadata.
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded) && (decoded as Record<string, unknown>).success === false) {
      return new Response(text, { status: response.status, headers: response.headers });
    }
    exact(decoded, ["success", "data", "meta"], ["message"]);
    if (decoded.success !== true || (decoded.message !== undefined && (typeof decoded.message !== "string" || decoded.message.length > MAX_ENVELOPE_BYTES))) invalid();
    exact(decoded.meta, ["timestamp", "compatMode"], ["requestId", "correlationId", "path", "method"]);
    timestamp(decoded.meta.timestamp); if (decoded.meta.compatMode !== "canonical") invalid();
    for (const key of ["requestId", "correlationId", "path", "method"] as const) {
      const part = decoded.meta[key]; if (part !== undefined && (typeof part !== "string" || part.length > (key === "path" ? 512 : key === "method" ? 16 : 256))) invalid();
    }
    if ((decoded.meta.path !== undefined && decoded.meta.path !== path) || (decoded.meta.method !== undefined && decoded.meta.method !== "POST")) invalid();
    if (Buffer.byteLength(JSON.stringify(decoded.data), "utf8") > maxPayloadBytes
      || Buffer.byteLength(JSON.stringify({ ...decoded, data: null }), "utf8") > MAX_ENVELOPE_BYTES) invalid();
  }
  return new Response(text, { status: response.status, headers: response.headers });
}
/** One bounded, credential-free, redirect-refusing HTTP client for a single proof operation. */
export function proofHttpClient(origin: string, timeoutMs: number, transport: typeof fetch, scope: AbortSignal, maxPayloadBytes: number,
  invalid: () => never, cancelled: () => AgentSdkError): HttpClient {
  return new HttpClient({ baseUrl: `${origin}/api`, timeoutMs, retry: { maxAttempts: 1 },
    fetchFn: async (url, init) => {
      const abort = new AbortController(); const relay = () => abort.abort();
      const sources = [scope, init?.signal].filter((item): item is AbortSignal => Boolean(item));
      for (const signal of sources) { signal.addEventListener("abort", relay, { once: true }); if (signal.aborted) abort.abort(); }
      try {
        const response = await waitFor(() => Promise.resolve(transport(url, { ...init, signal: abort.signal, credentials: "omit", redirect: "error",
          headers: { ...init?.headers, "Cache-Control": "no-store" } })).then((received) => {
          if (abort.signal.aborted) { void received.body?.cancel().catch(() => undefined); throw cancelled(); } return received;
        }), abort.signal, cancelled);
        return await canonicalResponse(response, abort.signal, new URL(String(url)).pathname, maxPayloadBytes, invalid, cancelled);
      } finally { for (const signal of sources) signal.removeEventListener("abort", relay); }
    },
  });
}
/** Runs a signer under the nonce expiry and the operation scope; a late result is never used. */
export async function signWithin<T>(sign: () => T | PromiseLike<T>, expiresAt: string, scope: AbortSignal, invalid: () => never,
  cancelled: () => AgentSdkError): Promise<T> {
  const signing = new AbortController(); const abortSigning = () => signing.abort();
  scope.addEventListener("abort", abortSigning, { once: true }); if (scope.aborted) signing.abort();
  const expires = setTimeout(abortSigning, Math.max(1, timestampWith(invalid)(expiresAt) - Date.now()));
  try { return await waitFor(sign, signing.signal, cancelled); }
  catch { if (scope.aborted) throw cancelled(); return invalid(); }
  finally { clearTimeout(expires); scope.removeEventListener("abort", abortSigning); }
}
