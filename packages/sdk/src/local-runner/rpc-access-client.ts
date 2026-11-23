import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base64, cancelledFor, exactWith, invalidFor, matches, pinTarget, positive, proofHttpClient, proofNonceMessage, sha256,
  signWithin, targetPart, TARGET_KEYS, timestampWith, validateProofNonce, waitFor, type ExactFn,
  type RunnerProofNonce } from "./runner-proof-transport";

/** Owner decision of 17 Nov 2026: users are never asked for a Solana RPC. Balchemy provides two independent providers and the
 * runner connects to both DIRECTLY. This client fetches the grant (POST /api/nest/local-agents/rpc-access/{nonce,grant}) with the
 * same runner proof as the other runner routes. The grant holds live provider credentials: this module never logs them, and every
 * error it raises is a fixed message without any URL, token or header value. The runner pins the provider hosts on its own. */
export type RunnerRpcAccessTarget = RunnerRuntimeTarget;
export const RUNNER_RPC_ACCESS_PROVIDERS = ["alchemy", "helius", "quicknode", "triton", "syndica"] as const;
export type RunnerRpcAccessProvider = typeof RUNNER_RPC_ACCESS_PROVIDERS[number];
export interface RunnerRpcBearerAuth { readonly kind: "bearer"; readonly token: string; readonly expiresAt: string }
export interface RunnerRpcHeaderAuth { readonly kind: "header"; readonly name: string; readonly value: string }
export interface RunnerRpcNoneAuth { readonly kind: "none" }
export interface RunnerRpcSourceA { readonly id: "a"; readonly provider: RunnerRpcAccessProvider; readonly url: string; readonly auth: RunnerRpcBearerAuth | RunnerRpcNoneAuth }
export interface RunnerRpcSourceB { readonly id: "b"; readonly provider: RunnerRpcAccessProvider; readonly url: string; readonly auth: RunnerRpcHeaderAuth | RunnerRpcNoneAuth }
/** Version 1, closed. Treat every URL and credential as a secret: never log, print, persist or send them to Balchemy. */
export interface RunnerRpcAccessGrant {
  readonly version: 1; readonly issuedAt: string; readonly refreshAfter: string; readonly sources: readonly [RunnerRpcSourceA, RunnerRpcSourceB];
}
export type RunnerRpcAccessExpectedTarget = RunnerRpcAccessTarget & { epoch: number };
export type RunnerRpcAccessNonce = RunnerProofNonce<"balchemy.local-agent.rpc-access.v1">;
/** Runner key: sign only runnerRpcAccessNonceMessage after independently checking this context. Base64, 64 bytes. */
export type RunnerRpcAccessSigner = (nonce: Readonly<RunnerRpcAccessNonce>, expected: RunnerRpcAccessExpectedTarget) => string | Promise<string>;
export interface RunnerRpcAccessClientConfig extends RunnerRpcAccessTarget {
  apiBaseUrl: string; signer: RunnerRpcAccessSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/rpc-access";
const PURPOSE = "balchemy.local-agent.rpc-access.v1" as const;
const REQUEST_PURPOSE = "balchemy.local-agent.rpc-access.request.v1";
/** Two URLs (up to 2048 bytes each), a JWT and a header token fit well inside this. */
const MAX_PAYLOAD_BYTES = 12_288;
const MAX_URL_LENGTH = 2048;
const MAX_TOKEN_LENGTH = 4096;
/** A 503 body is read only to find its bounded reason. */
const MAX_FAILURE_BYTES = 8192;
/** `details.reason` of the configuration 503 (backend LOCAL_AGENT_RPC_ACCESS_UNAVAILABLE_REASON). */
const UNAVAILABLE_REASON = "rpc_access_unavailable";
/** AgentSdkError.machineCode of a 503 whose reason is `rpc_access_unavailable`: Balchemy has not configured (or misconfigured) the
 * provider credentials. Keep the current grant while it is valid and retry after 5 minutes or more. A 503 without that reason keeps
 * the generic machine code (a transient dependency failure: retry with backoff). */
export const RUNNER_RPC_ACCESS_UNAVAILABLE = "RPC_ACCESS_UNAVAILABLE";
/** The grant's refresh point lies at most this far after its issue time (the backend uses 20 minutes). */
const MAX_REFRESH_WINDOW_MS = 60 * 60_000;
const JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const HEADER_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Header names the runner's HTTP client owns; a provider token must never override them. */
const RESERVED_HEADERS: readonly string[] = ["authorization", "proxy-authorization", "host", "cookie", "content-type", "content-length",
  "connection", "transfer-encoding", "accept", "accept-encoding", "user-agent", "cache-control"];
const TOKEN = /^[\x21-\x7e]{8,512}$/;
const invalid: () => never = invalidFor("RPC access");
const cancelled = cancelledFor("RPC access");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);

/** The fixed request digest: SHA256(UTF8(JSON.stringify(["balchemy.local-agent.rpc-access.request.v1", 1]))). */
export function runnerRpcAccessRequestDigest(): string { return sha256([REQUEST_PURPOSE, 1]); }
function expected(value: RunnerRpcAccessExpectedTarget): RunnerRpcAccessExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch });
}
export function validateRunnerRpcAccessNonce(value: unknown, expectedTarget: RunnerRpcAccessExpectedTarget, now = Date.now()): RunnerRpcAccessNonce {
  return validateProofNonce(value, expected(expectedTarget), PURPOSE, "rpc-access/grant", runnerRpcAccessRequestDigest(), now, invalid);
}
export function runnerRpcAccessNonceMessage(value: RunnerRpcAccessNonce, expectedTarget: RunnerRpcAccessExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerRpcAccessNonce(value, expectedTarget, now));
}
/** https only, no userinfo or fragment, no control or space characters; returned exactly as given (never re-serialized). */
function providerUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 9 || value.length > MAX_URL_LENGTH || /[\u0000- \u007f-\u009f]/.test(value)) invalid();
  let url: URL;
  try { url = new URL(value as string); } catch { return invalid(); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !url.hostname || url.hostname.endsWith(".")) invalid();
  return value as string;
}
function provider(value: unknown): RunnerRpcAccessProvider {
  if (typeof value !== "string" || !(RUNNER_RPC_ACCESS_PROVIDERS as readonly string[]).includes(value)) invalid();
  return value as RunnerRpcAccessProvider;
}
function auth(value: unknown, id: "a" | "b", issuedAt: number): RunnerRpcBearerAuth | RunnerRpcHeaderAuth | RunnerRpcNoneAuth {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "none") { exact(value, ["kind"]); return Object.freeze({ kind: "none" as const }); }
  if (kind === "bearer" && id === "a") {
    exact(value, ["kind", "token", "expiresAt"]);
    if (typeof value.token !== "string" || value.token.length > MAX_TOKEN_LENGTH || !JWS.test(value.token)) invalid();
    const expires = timestamp(value.expiresAt); if (expires <= issuedAt) invalid();
    return Object.freeze({ kind: "bearer" as const, token: value.token as string, expiresAt: value.expiresAt as string });
  }
  if (kind === "header" && id === "b") {
    exact(value, ["kind", "name", "value"]);
    if (!matches(value.name, HEADER_NAME) || RESERVED_HEADERS.includes(value.name) || !matches(value.value, TOKEN)) invalid();
    return Object.freeze({ kind: "header" as const, name: value.name as string, value: value.value as string });
  }
  return invalid();
}
/** Strict parser of grant version 1: exact keys at every level, https URLs, the closed provider set, two different providers,
 * bearer only on source a, header only on source b, `none` on either. Any other version or shape is refused. Never logs. */
export function validateRunnerRpcAccessGrant(value: unknown, now = Date.now()): RunnerRpcAccessGrant {
  exact(value, ["version", "issuedAt", "refreshAfter", "sources"]);
  if (value.version !== 1 || !Array.isArray(value.sources) || value.sources.length !== 2 || !Number.isFinite(now)) invalid();
  const issued = timestamp(value.issuedAt); const refresh = timestamp(value.refreshAfter);
  if (refresh <= issued || refresh - issued > MAX_REFRESH_WINDOW_MS || issued > now + 5 * 60_000) invalid();
  const parsed = (value.sources as unknown[]).map((source, index) => {
    const id = index === 0 ? "a" as const : "b" as const;
    exact(source, ["id", "provider", "url", "auth"]);
    if (source.id !== id) invalid();
    return Object.freeze({ id, provider: provider(source.provider), url: providerUrl(source.url), auth: auth(source.auth, id, issued) });
  });
  const [a, b] = parsed as unknown as [RunnerRpcSourceA, RunnerRpcSourceB];
  if (a.provider === b.provider) invalid();
  if (new URL(a.url).hostname.toLowerCase() === new URL(b.url).hostname.toLowerCase()) invalid();
  return Object.freeze({ version: 1, issuedAt: value.issuedAt as string, refreshAfter: value.refreshAfter as string, sources: Object.freeze([a, b]) as unknown as readonly [RunnerRpcSourceA, RunnerRpcSourceB] });
}
/** `details.reason` of a 503 body (canonical `error.details.reason` or legacy `details.reason`) when it is the known one. */
function unavailableReason(text: string): boolean {
  let body: unknown; try { body = JSON.parse(text) as unknown; } catch { return false; }
  const reason = (item: unknown): unknown => item && typeof item === "object" && !Array.isArray(item)
    ? ((item as { details?: unknown }).details as { reason?: unknown } | null | undefined)?.reason : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return (reason((body as { error?: unknown }).error) ?? reason(body)) === UNAVAILABLE_REASON;
}

/** Public runner route only (POST /api/nest/local-agents/rpc-access/{nonce,grant}); credential-free, redirect-refusing. */
export class RunnerRpcAccessClient {
  private readonly pinned: RunnerRpcAccessTarget;
  private readonly signer: RunnerRpcAccessSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerRpcAccessClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 15_000; this.transport = config.fetchFn ?? fetch;
  }
  /** One signed attempt (nonce, signature, grant). A 503 `rpc_access_unavailable` is an AgentSdkError with machineCode
   * RUNNER_RPC_ACCESS_UNAVAILABLE; a 429 carries `retryAfterSeconds` when the server sent Retry-After. */
  async grant(epoch: number, callerSignal?: AbortSignal): Promise<RunnerRpcAccessGrant> {
    const operation = expected({ ...this.pinned, epoch });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    // Only a 503 body is inspected, for its closed reason; the bytes are handed on unchanged.
    let notConfigured = false;
    const transport: typeof fetch = async (url, init) => {
      const response = await this.transport(url, init);
      if (response.status !== 503) return response;
      const text = await readBoundedResponseText(response, MAX_FAILURE_BYTES, init?.signal ?? undefined);
      notConfigured = unavailableReason(text);
      return new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerRpcAccessRequestDigest() },
      { kind: "side_effecting", operation: "local-agent:rpc-access-nonce" }), scope.signal, cancelled);
      const nonce = validateRunnerRpcAccessNonce(data, operation);
      const signature = await signWithin(() => this.signer(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      validateRunnerRpcAccessNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const response = await waitFor(() => http.post<unknown>(`${PATH}/grant`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch },
        { kind: "side_effecting", operation: "local-agent:rpc-access-grant" }), scope.signal, cancelled);
      return validateRunnerRpcAccessGrant(response);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError && error.status === 503 && notConfigured) {
        throw new AgentSdkError({ code: error.code, status: 503, message: "Local-agent RPC access is not configured",
          details: { layer: "http_ingress", code: RUNNER_RPC_ACCESS_UNAVAILABLE, retryable: true } });
      }
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
