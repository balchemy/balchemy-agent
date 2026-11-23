import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";
import type { RunnerRuntimeTarget } from "./runtime-client";
import { base64, cancelledFor, exactWith, invalidFor, matches, pinTarget, positive, proofHttpClient, proofNonceMessage, sha256,
  signWithin, targetPart, TARGET_KEYS, timestampWith, validateProofNonce, waitFor, type ExactFn,
  type RunnerProofNonce } from "./runner-proof-transport";

/** K4 launchpad signal sources (owner decision of 19 Nov 2026): a public catalog of Solana launchpads and the agent's runner-signed
 * subscription (no wallet signature). Contract: BALCHEMY-FORENSIC-2026-10-04/m0m1/s5/prep/k4-launchpad-contract.md.
 * - GET /api/nest/local-agents/launchpads: public, credential-free, closed response (version 1, chain solana).
 * - POST /api/nest/local-agents/launchpad-subscriptions/{nonce,query}: the same runner proof as the signals route; `get` reads and
 *   `set` replaces the whole subscription (ids strictly ascending, at most 32; `[]` unsubscribes).
 * A launchpad signal is a public launch observation, never a buy signal or execution authority. */
export const RUNNER_LAUNCHPAD_STATUSES = ["live", "coming_soon"] as const;
export type RunnerLaunchpadStatus = typeof RUNNER_LAUNCHPAD_STATUSES[number];
export interface RunnerLaunchpad {
  readonly id: string; readonly name: string; readonly chain: "solana"; readonly status: RunnerLaunchpadStatus;
  /** The `sourceId` every signal from this launchpad carries (the same for every agent). */
  readonly sourceId: string; readonly programIds: readonly string[]; readonly sourceNote: string;
}
export interface RunnerLaunchpadCatalog { readonly version: 1; readonly chain: "solana"; readonly launchpads: readonly RunnerLaunchpad[] }
export type RunnerLaunchpadSubscriptionsRequest = { kind: "get" } | { kind: "set"; launchpadIds: readonly string[] };
/** revision 0 with no ids and updatedAt null: never subscribed under the current binding. */
export interface RunnerLaunchpadSubscription { readonly revision: number; readonly launchpadIds: readonly string[]; readonly updatedAt: string | null }
export interface RunnerLaunchpadSubscriptionsResponse {
  readonly version: 1; readonly requestDigest: string; readonly agentId: string; readonly bindingDigest: string; readonly instanceId: string;
  readonly epoch: number; readonly completedAt: string; readonly subscription: RunnerLaunchpadSubscription;
}
export type RunnerLaunchpadSubscriptionsTarget = RunnerRuntimeTarget;
export type RunnerLaunchpadSubscriptionsExpectedTarget = RunnerLaunchpadSubscriptionsTarget & { epoch: number; request: RunnerLaunchpadSubscriptionsRequest };
export type RunnerLaunchpadSubscriptionsNonce = RunnerProofNonce<"balchemy.local-agent.launchpad-subscriptions.query.v1">;
/** Runner key: sign only runnerLaunchpadSubscriptionsNonceMessage after independently checking this context. Base64, 64 bytes. */
export type RunnerLaunchpadSubscriptionsSigner = (nonce: Readonly<RunnerLaunchpadSubscriptionsNonce>,
  expected: RunnerLaunchpadSubscriptionsExpectedTarget) => string | Promise<string>;
export interface RunnerLaunchpadSubscriptionsClientConfig extends RunnerLaunchpadSubscriptionsTarget {
  apiBaseUrl: string; signer: RunnerLaunchpadSubscriptionsSigner; timeoutMs?: number; fetchFn?: typeof fetch;
}
/** AgentSdkError.machineCode of a 400 whose closed `details.reason` names a refused launchpad. */
export const RUNNER_LAUNCHPAD_REFUSALS = ["launchpad_unknown", "launchpad_not_live"] as const;
export type RunnerLaunchpadRefusal = typeof RUNNER_LAUNCHPAD_REFUSALS[number];
export const RUNNER_LAUNCHPAD_MAX_SUBSCRIPTIONS = 32;
/** Stable launchpad slug (backend LOCAL_AGENT_LAUNCHPAD_ID). */
export const RUNNER_LAUNCHPAD_ID = /^[a-z][a-z0-9_]{1,31}$/;

const CATALOG_PATH = "/nest/local-agents/launchpads";
const PATH = "/nest/local-agents/launchpad-subscriptions";
const PURPOSE = "balchemy.local-agent.launchpad-subscriptions.query.v1" as const;
const REQUEST_PURPOSE = "balchemy.local-agent.launchpad-subscriptions.request.v1";
const MAX_PAYLOAD_BYTES = 8192;
const MAX_CATALOG_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 4096;
const MAX_FAILURE_BYTES = 8192;
const MAX_CATALOG_ENTRIES = 64;
const SOURCE_ID = /^src_[0-9a-f]{24}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const invalid: () => never = invalidFor("launchpad");
const cancelled = cancelledFor("launchpad");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) invalid();
  return value as string;
}
function strictArray(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1 || Object.keys(value).length !== value.length
    || Object.values(Object.getOwnPropertyDescriptors(value)).some((field) => !("value" in field))) invalid();
  return value as unknown[];
}
/** Strictly ascending launchpad ids (plain code-unit order, as the server compares), at most 32. */
function launchpadIds(value: unknown): string[] {
  const ids = strictArray(value, RUNNER_LAUNCHPAD_MAX_SUBSCRIPTIONS);
  for (let index = 0; index < ids.length; index++) {
    if (!matches(ids[index], RUNNER_LAUNCHPAD_ID) || (index > 0 && (ids[index - 1] as string) >= (ids[index] as string))) invalid();
  }
  return [...ids] as string[];
}
/** Sorted unique ids in the server's order; refuses a malformed id or more than 32. */
export function canonicalRunnerLaunchpadIds(ids: readonly string[]): string[] {
  if (!Array.isArray(ids)) invalid();
  return launchpadIds([...new Set(ids)].sort());
}

/** Closed catalog parser (version 1, chain solana, unique ids and source ids; a coming-soon entry may list no program ids). */
export function validateRunnerLaunchpadCatalog(value: unknown): RunnerLaunchpadCatalog {
  exact(value, ["version", "chain", "launchpads"]);
  if (value.version !== 1 || value.chain !== "solana") invalid();
  const ids = new Set<string>(); const sources = new Set<string>();
  const launchpads = strictArray(value.launchpads, MAX_CATALOG_ENTRIES).map((entry): RunnerLaunchpad => {
    exact(entry, ["id", "name", "chain", "status", "sourceId", "programIds", "sourceNote"]);
    if (!matches(entry.id, RUNNER_LAUNCHPAD_ID) || entry.chain !== "solana" || !matches(entry.sourceId, SOURCE_ID)
      || !(RUNNER_LAUNCHPAD_STATUSES as readonly unknown[]).includes(entry.status) || ids.has(entry.id) || sources.has(entry.sourceId)) invalid();
    const programIds = strictArray(entry.programIds, 8).map((item) => { if (!matches(item, SOLANA_ADDRESS)) invalid(); return item as string; });
    if (entry.status === "live" && programIds.length === 0) invalid();
    ids.add(entry.id); sources.add(entry.sourceId);
    return Object.freeze({ id: entry.id, name: text(entry.name, 64), chain: "solana", status: entry.status as RunnerLaunchpadStatus,
      sourceId: entry.sourceId, programIds: Object.freeze(programIds), sourceNote: text(entry.sourceNote, 512) });
  });
  return Object.freeze({ version: 1, chain: "solana", launchpads: Object.freeze(launchpads) });
}

/** One bounded, credential-free, redirect-refusing read of the public catalog (the canonical success envelope is required). */
export async function fetchRunnerLaunchpadCatalog(options: { frontendOrigin: string; fetchFn?: typeof fetch; timeoutMs?: number },
  callerSignal?: AbortSignal): Promise<RunnerLaunchpadCatalog> {
  let origin: URL;
  try { origin = new URL(options.frontendOrigin); } catch { return invalid(); }
  if (origin.origin !== options.frontendOrigin || origin.username || origin.password
    || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)))) invalid();
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!positive(timeoutMs) || timeoutMs > 30_000 || (options.fetchFn !== undefined && typeof options.fetchFn !== "function")) invalid();
  const scope = new AbortController(); const forward = () => scope.abort();
  callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
  const deadline = setTimeout(forward, timeoutMs);
  try {
    const response = await waitFor(() => (options.fetchFn ?? fetch)(`${origin.origin}/api${CATALOG_PATH}`, { method: "GET", signal: scope.signal,
      credentials: "omit", redirect: "error", headers: { accept: "application/json", "Cache-Control": "no-store" } }), scope.signal, cancelled);
    if (response.status !== 200 || response.redirected) {
      await response.body?.cancel().catch(() => undefined);
      throw new AgentSdkError({ code: response.status === 429 ? "rate_limit_error" : "network_error", status: response.status,
        message: "Local-agent launchpad catalog unavailable", details: { layer: "http_ingress", retryable: true } });
    }
    const body = await waitFor(() => readBoundedResponseText(response, MAX_CATALOG_BYTES + MAX_ENVELOPE_BYTES, scope.signal), scope.signal, cancelled);
    let decoded: unknown; try { decoded = JSON.parse(body) as unknown; } catch { return invalid(); }
    exact(decoded, ["success", "data", "meta"], ["message"]);
    if (decoded.success !== true) invalid();
    return validateRunnerLaunchpadCatalog(decoded.data);
  } catch (error: unknown) {
    if (scope.signal.aborted) throw cancelled();
    if (error instanceof AgentSdkError) throw error;
    return invalid();
  } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
}

function subscriptionsRequest(value: unknown): RunnerLaunchpadSubscriptionsRequest {
  exact(value, ["kind"], ["launchpadIds"]);
  if (value.kind === "get") { exact(value, ["kind"]); return Object.freeze({ kind: "get" }); }
  exact(value, ["kind", "launchpadIds"]);
  if (value.kind !== "set") invalid();
  return Object.freeze({ kind: "set", launchpadIds: Object.freeze(launchpadIds(value.launchpadIds)) });
}
/** SHA256(UTF8(JSON.stringify([REQUEST_PURPOSE, "get"]))) or SHA256(UTF8(JSON.stringify([REQUEST_PURPOSE, "set", launchpadIds]))). */
export function runnerLaunchpadSubscriptionsRequestDigest(value: RunnerLaunchpadSubscriptionsRequest): string {
  const checked = subscriptionsRequest(value);
  return sha256(checked.kind === "get" ? [REQUEST_PURPOSE, "get"] : [REQUEST_PURPOSE, "set", checked.launchpadIds]);
}
function expected(value: RunnerLaunchpadSubscriptionsExpectedTarget): RunnerLaunchpadSubscriptionsExpectedTarget {
  exact(value, [...TARGET_KEYS, "epoch", "request"]);
  if (!positive(value.epoch)) invalid();
  return Object.freeze({ ...pinTarget(targetPart(value), invalid), epoch: value.epoch, request: subscriptionsRequest(value.request) });
}
export function validateRunnerLaunchpadSubscriptionsNonce(value: unknown, expectedTarget: RunnerLaunchpadSubscriptionsExpectedTarget,
  now = Date.now()): RunnerLaunchpadSubscriptionsNonce {
  const pinned = expected(expectedTarget);
  return validateProofNonce(value, pinned, PURPOSE, "launchpad-subscriptions/query", runnerLaunchpadSubscriptionsRequestDigest(pinned.request), now, invalid);
}
export function runnerLaunchpadSubscriptionsNonceMessage(value: RunnerLaunchpadSubscriptionsNonce,
  expectedTarget: RunnerLaunchpadSubscriptionsExpectedTarget, now = Date.now()): string {
  return proofNonceMessage(validateRunnerLaunchpadSubscriptionsNonce(value, expectedTarget, now));
}
/** Closed response; a `set` must answer exactly the ids it asked for. */
export function validateRunnerLaunchpadSubscriptionsResponse(value: unknown, expectedTarget: RunnerLaunchpadSubscriptionsExpectedTarget,
  now = Date.now()): RunnerLaunchpadSubscriptionsResponse {
  const pinned = expected(expectedTarget);
  exact(value, ["version", "requestDigest", "agentId", "bindingDigest", "instanceId", "epoch", "completedAt", "subscription"]);
  if (!Number.isFinite(now) || value.version !== 1 || value.requestDigest !== runnerLaunchpadSubscriptionsRequestDigest(pinned.request)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId
    || value.epoch !== pinned.epoch || Math.abs(timestamp(value.completedAt) - now) > 5 * 60_000) invalid();
  exact(value.subscription, ["revision", "launchpadIds", "updatedAt"]);
  const { revision, updatedAt } = value.subscription;
  const ids = launchpadIds(value.subscription.launchpadIds);
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0
    || (revision === 0) !== (updatedAt === null) || (revision === 0 && ids.length > 0)
    || (updatedAt !== null && timestamp(updatedAt) > timestamp(value.completedAt) + 5_000)) invalid();
  if (pinned.request.kind === "set" && JSON.stringify(ids) !== JSON.stringify(pinned.request.launchpadIds)) invalid();
  return Object.freeze({ version: 1, requestDigest: value.requestDigest as string, agentId: value.agentId as string,
    bindingDigest: value.bindingDigest as string, instanceId: value.instanceId as string, epoch: value.epoch as number,
    completedAt: value.completedAt as string, subscription: Object.freeze({ revision, launchpadIds: Object.freeze(ids), updatedAt: updatedAt as string | null }) });
}
/** The closed refusal of a 400 body (canonical `error.details.reason` or legacy `details.reason`), else undefined. */
function refusalReason(text: string): RunnerLaunchpadRefusal | undefined {
  let body: unknown; try { body = JSON.parse(text) as unknown; } catch { return undefined; }
  const reason = (item: unknown): unknown => item && typeof item === "object" && !Array.isArray(item)
    ? ((item as { details?: unknown }).details as { reason?: unknown } | null | undefined)?.reason : undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const found = reason((body as { error?: unknown }).error) ?? reason(body);
  return (RUNNER_LAUNCHPAD_REFUSALS as readonly unknown[]).includes(found) ? found as RunnerLaunchpadRefusal : undefined;
}

/** Public runner route only; credential-free, redirect-refusing, one signed attempt per call. */
export class RunnerLaunchpadSubscriptionsClient {
  private readonly pinned: RunnerLaunchpadSubscriptionsTarget;
  private readonly signer: RunnerLaunchpadSubscriptionsSigner;
  private readonly timeoutMs: number;
  private readonly transport: typeof fetch;
  constructor(config: RunnerLaunchpadSubscriptionsClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = pinTarget(targetPart(config), invalid);
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 30_000))) invalid();
    this.signer = config.signer; this.timeoutMs = config.timeoutMs ?? 15_000; this.transport = config.fetchFn ?? fetch;
  }
  /** A refused launchpad (400 `launchpad_unknown` / `launchpad_not_live`) is an AgentSdkError whose machineCode is that reason in
   * upper case (LAUNCHPAD_UNKNOWN / LAUNCHPAD_NOT_LIVE). */
  async query(input: RunnerLaunchpadSubscriptionsRequest, epoch: number, callerSignal?: AbortSignal): Promise<RunnerLaunchpadSubscriptionsResponse> {
    const operation = expected({ ...this.pinned, epoch, request: input });
    if (callerSignal !== undefined && !(callerSignal instanceof AbortSignal)) invalid();
    const scope = new AbortController(); const forward = () => scope.abort();
    callerSignal?.addEventListener("abort", forward, { once: true }); if (callerSignal?.aborted) scope.abort();
    const deadline = setTimeout(forward, this.timeoutMs);
    // Only a 400 body is inspected, for its closed reason; the bytes are handed on unchanged.
    let refused: RunnerLaunchpadRefusal | undefined;
    const transport: typeof fetch = async (url, init) => {
      const response = await this.transport(url, init);
      if (response.status !== 400) return response;
      const body = await readBoundedResponseText(response, MAX_FAILURE_BYTES, init?.signal ?? undefined);
      refused = refusalReason(body);
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    };
    const http = proofHttpClient(this.pinned.frontendOrigin, this.timeoutMs, transport, scope.signal, MAX_PAYLOAD_BYTES, invalid, cancelled);
    try {
      const data = await waitFor(() => http.post<unknown>(`${PATH}/nonce`, { agentId: operation.agentId, bindingDigest: operation.bindingDigest,
        instanceId: operation.instanceId, epoch: operation.epoch, requestDigest: runnerLaunchpadSubscriptionsRequestDigest(operation.request) },
      { kind: "side_effecting", operation: "local-agent:launchpad-subscriptions-nonce" }), scope.signal, cancelled);
      const nonce = validateRunnerLaunchpadSubscriptionsNonce(data, operation);
      const signature = await signWithin(() => this.signer(nonce, operation), nonce.expiresAt, scope.signal, invalid, cancelled);
      validateRunnerLaunchpadSubscriptionsNonce(nonce, operation); if (!base64(signature, 64)) invalid();
      const body = operation.request.kind === "get" ? { kind: "get" } : { kind: "set", launchpadIds: [...operation.request.launchpadIds] };
      const response = await waitFor(() => http.post<unknown>(`${PATH}/query`, { nonceId: nonce.nonceId, signature, epoch: operation.epoch, request: body },
        { kind: "side_effecting", operation: "local-agent:launchpad-subscriptions-query" }), scope.signal, cancelled);
      return validateRunnerLaunchpadSubscriptionsResponse(response, operation);
    } catch (error: unknown) {
      if (scope.signal.aborted) throw cancelled();
      if (error instanceof AgentSdkError && error.status === 400 && refused) {
        // Machine codes are upper snake case (failure-metadata MACHINE_CODE_RE); the closed reason stays in details.reason.
        throw new AgentSdkError({ code: error.code, status: 400, message: "Local-agent launchpad refused",
          details: { layer: "http_ingress", code: refused.toUpperCase(), reason: refused, retryable: false } });
      }
      if (error instanceof AgentSdkError) throw error;
      return invalid();
    } finally { clearTimeout(deadline); callerSignal?.removeEventListener("abort", forward); scope.abort(); }
  }
}
