import { createHash } from "node:crypto";
import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";

/** Public liveness protocol only; no owner credential, brain, or execution authority. */
export interface RunnerRuntimeTarget {
  frontendOrigin: string;
  agentId: string;
  bindingDigest: string;
  runnerPublicKey: string;
  instanceId: string;
}
/** shadow and paused are the original vocabulary; live_unarmed/live_armed come from runners with explicit CLI arming. */
export const RUNNER_RUNTIME_MODES = ["shadow", "paused", "live_unarmed", "live_armed"] as const;
export type RunnerRuntimeMode = typeof RUNNER_RUNTIME_MODES[number];
export interface RunnerRuntimeState {
  mode: RunnerRuntimeMode;
  lifecycle: "idle" | "stopped";
  /** Positive safe integer revision of the durable local state. */
  version: number;
  /** True exactly when mode is live_armed (armed only by the owner's local CLI; never by the server or web). */
  armed: boolean;
  execution: "unavailable";
  brain: "not_attached";
  /** New autonomous entries of a live_armed agent: present exactly for live_armed (owner pause keeps it armed with
   * entries "paused": no new buy, protective exits continue). Absent in every other mode and from older runners. */
  entries?: RunnerRuntimeEntries;
}
export const RUNNER_RUNTIME_ENTRIES = ["enabled", "paused"] as const;
export type RunnerRuntimeEntries = typeof RUNNER_RUNTIME_ENTRIES[number];
/** stopped implies paused; armed is true exactly for live_armed. */
export function isRunnerRuntimeModeState(mode: unknown, lifecycle: unknown, armed: unknown): boolean {
  return RUNNER_RUNTIME_MODES.includes(mode as RunnerRuntimeMode) && (lifecycle === "idle" || lifecycle === "stopped")
    && (lifecycle !== "stopped" || mode === "paused") && typeof armed === "boolean" && armed === (mode === "live_armed");
}
/** `entries` (enabled | paused) is present exactly for live_armed; `undefined` means the key is absent. */
export function isRunnerRuntimeEntriesState(mode: unknown, entries: unknown): boolean {
  return mode === "live_armed" ? RUNNER_RUNTIME_ENTRIES.includes(entries as RunnerRuntimeEntries) : entries === undefined;
}
/** Digest tuple of a state: the six original fields, then `entries` only when present (older states keep their digest). */
export function runnerRuntimeStateTuple(value: RunnerRuntimeState): unknown[] {
  const tuple: unknown[] = [value.mode, value.lifecycle, value.version, value.armed, value.execution, value.brain];
  if (value.entries !== undefined) tuple.push(value.entries);
  return tuple;
}
/** Shared strict state parse (runtime and control): exact keys, mode/lifecycle/armed/entries invariants. */
export function parseRunnerRuntimeState(value: unknown, fail: () => never): RunnerRuntimeState {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const record = value as Record<string, unknown>;
  const keys = ["mode", "lifecycle", "version", "armed", "execution", "brain", ...(record.mode === "live_armed" ? ["entries"] : [])];
  const descriptors = Object.getOwnPropertyDescriptors(record);
  if (Reflect.ownKeys(record).length !== keys.length || !keys.every((key) => Object.hasOwn(descriptors, key))
    || Object.values(descriptors).some((field) => !("value" in field) || !field.enumerable)) fail();
  if (!isRunnerRuntimeModeState(record.mode, record.lifecycle, record.armed) || !isRunnerRuntimeEntriesState(record.mode, record.entries)
    || typeof record.version !== "number" || !Number.isSafeInteger(record.version) || record.version <= 0
    || record.execution !== "unavailable" || record.brain !== "not_attached") fail();
  return Object.freeze({ ...record }) as unknown as RunnerRuntimeState;
}
/** Bounded operational observation, never model context or execution authority. */
export interface RunnerBrainObservation {
  version: 1;
  model: "locked" | "ready" | "unavailable";
  /** Current owner-confirmed Solana rule head, never a recent-job inference. */
  rules: "not_checked" | "confirmed" | "missing" | "held" | "unavailable";
  /** Autonomous decision processing only; does not describe private chat or trades. */
  activity: "idle" | "pending" | "running";
  /** Last durable signal terminal observed in this daemon instance. */
  lastTerminal: "none" | "completed" | "held" | "failed" | "cancelled" | "interrupted";
}
/** Trading-keystore lock state, a closed enum with no address or key material. The passphrase is never stored, so every
 * daemon start leaves a configured wallet "locked" until the owner enters it. */
export const RUNNER_KEYSTORE_LOCKS = ["locked", "unlocked", "not_configured", "unavailable"] as const;
export type RunnerKeystoreLock = typeof RUNNER_KEYSTORE_LOCKS[number];
/** Whether this runner build can run automatic exits (stop-losses) at all: its fixed exits capability, never a claim that
 * an exit is running. */
export const RUNNER_EXIT_CAPABILITIES = ["available", "unavailable"] as const;
export type RunnerExitCapability = typeof RUNNER_EXIT_CAPABILITIES[number];
/** One closed observation (digest tag balchemy.local-agent.keystore-observation.v2); older runners omit it. */
export interface RunnerKeystoreObservation { lock: RunnerKeystoreLock; exits: RunnerExitCapability }
export interface RunnerRuntimeAcquireBody { requestId: string; state: RunnerRuntimeState; brainObservation?: RunnerBrainObservation; keystore?: RunnerKeystoreObservation }
export interface RunnerRuntimeHeartbeatBody { epoch: number; sequence: number; state: RunnerRuntimeState; brainObservation?: RunnerBrainObservation; keystore?: RunnerKeystoreObservation }
export type RunnerRuntimeActionBody =
  | { action: "acquire"; body: RunnerRuntimeAcquireBody }
  | { action: "heartbeat"; body: RunnerRuntimeHeartbeatBody };
export type RunnerRuntimeAction = RunnerRuntimeActionBody["action"];
export interface RunnerRuntimeNonce {
  version: 1;
  purpose: "balchemy.local-agent.runtime.acquire.v1" | "balchemy.local-agent.runtime.heartbeat.v1";
  audience: string;
  nonceId: string;
  agentId: string;
  bindingDigest: string;
  runnerPublicKey: string;
  instanceId: string;
  action: RunnerRuntimeAction;
  bodyDigest: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}
export interface RunnerRuntimeLeaseReceipt {
  agentId: string;
  bindingDigest: string;
  instanceId: string;
  epoch: number;
  sequence: number;
  acceptedAt: string;
  leaseExpiresAt: string;
  state: RunnerRuntimeState;
  brainObservation?: RunnerBrainObservation;
  keystore?: RunnerKeystoreObservation;
  serverTime: string;
  heartbeatIntervalMs: 10000;
  leaseDurationMs: 30000;
}
export type RunnerRuntimeExpectedTarget = RunnerRuntimeTarget & RunnerRuntimeActionBody;
/** Sign only the dedicated message after independently checking this exact target. */
export type RunnerRuntimeSigner = (
  nonce: Readonly<RunnerRuntimeNonce>,
  expectedTarget: RunnerRuntimeExpectedTarget,
) => string | Promise<string>;
export interface RunnerRuntimeClientConfig extends RunnerRuntimeTarget {
  apiBaseUrl: string;
  signer: RunnerRuntimeSigner;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/runtime";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const TARGET_KEYS = ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "instanceId"] as const;
const NONCE_KEYS = ["version", "purpose", "audience", "nonceId", "agentId", "bindingDigest", "runnerPublicKey", "instanceId", "action", "bodyDigest", "nonce", "issuedAt", "expiresAt"] as const;
const RECEIPT_KEYS = ["agentId", "bindingDigest", "instanceId", "epoch", "sequence", "acceptedAt", "leaseExpiresAt", "state", "serverTime", "heartbeatIntervalMs", "leaseDurationMs"] as const;
const CLOCK_SKEW_MS = 5_000;

function invalid(): never {
  throw new AgentSdkError({ code: "invalid_response", message: "Invalid local-agent runtime protocol", details: { retryable: false } });
}
/** The same refusal, marked only where a comparison of Balchemy's own time with this computer's clock proves they differ by more
 * than CLOCK_SKEW_MS (final audit N5). The code and message are unchanged; `reason` is the one closed literal "clock_skew". */
function clockSkew(): never {
  throw new AgentSdkError({ code: "invalid_response", message: "Invalid local-agent runtime protocol", details: { retryable: false, reason: "clock_skew" } });
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!required.every((key) => Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
    || Object.values(descriptors).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
export function validateRunnerBrainObservation(value: unknown): RunnerBrainObservation {
  exact(value, ["version", "model", "rules", "activity", "lastTerminal"]);
  if (value.version !== 1 || !["locked", "ready", "unavailable"].includes(value.model as string)
    || !["not_checked", "confirmed", "missing", "held", "unavailable"].includes(value.rules as string)
    || !["idle", "pending", "running"].includes(value.activity as string)
    || !["none", "completed", "held", "failed", "cancelled", "interrupted"].includes(value.lastTerminal as string)
    || [value.model, value.rules, value.activity, value.lastTerminal].some((field) => typeof field !== "string")) invalid();
  return Object.freeze({ version: 1, model: value.model, rules: value.rules, activity: value.activity, lastTerminal: value.lastTerminal }) as RunnerBrainObservation;
}
export function validateRunnerKeystoreObservation(value: unknown): RunnerKeystoreObservation {
  exact(value, ["lock", "exits"]);
  if (typeof value.lock !== "string" || !(RUNNER_KEYSTORE_LOCKS as readonly string[]).includes(value.lock)
    || typeof value.exits !== "string" || !(RUNNER_EXIT_CAPABILITIES as readonly string[]).includes(value.exits)) invalid();
  return Object.freeze({ lock: value.lock, exits: value.exits }) as RunnerKeystoreObservation;
}
function observation(value: Record<string, unknown>): { brainObservation?: RunnerBrainObservation; keystore?: RunnerKeystoreObservation } {
  return { ...(Object.hasOwn(value, "brainObservation") ? { brainObservation: validateRunnerBrainObservation(value.brainObservation) } : {}),
    ...(Object.hasOwn(value, "keystore") ? { keystore: validateRunnerKeystoreObservation(value.keystore) } : {}) };
}
function observationTuple(value: RunnerBrainObservation): unknown[] {
  return [value.version, value.model, value.rules, value.activity, value.lastTerminal];
}
function matches(value: unknown, pattern: RegExp): value is string { return typeof value === "string" && pattern.test(value); }
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function base64(value: unknown, length: number): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length === length && bytes.toString("base64") === value;
}
function timestamp(value: unknown): number {
  if (typeof value !== "string" || value.length !== 24) invalid();
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) invalid();
  return time;
}
function target(value: unknown): RunnerRuntimeTarget {
  exact(value, TARGET_KEYS);
  if (typeof value.frontendOrigin !== "string" || !matches(value.agentId, UUID) || !matches(value.instanceId, UUID)
    || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32)) invalid();
  try {
    const url = new URL(value.frontendOrigin);
    if (value.frontendOrigin !== url.origin || url.username || url.password
      || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  } catch { invalid(); }
  return Object.freeze({ ...value }) as unknown as RunnerRuntimeTarget;
}
function state(value: unknown): RunnerRuntimeState { return parseRunnerRuntimeState(value, invalid); }
function intent(action: unknown, body: unknown): RunnerRuntimeActionBody {
  if (action === "acquire") {
    exact(body, ["requestId", "state"], ["brainObservation", "keystore"]);
    if (!matches(body.requestId, UUID)) invalid();
    return Object.freeze({ action, body: Object.freeze({ requestId: body.requestId, state: state(body.state), ...observation(body) }) });
  }
  if (action === "heartbeat") {
    exact(body, ["epoch", "sequence", "state"], ["brainObservation", "keystore"]);
    if (!positive(body.epoch) || !positive(body.sequence)) invalid();
    return Object.freeze({ action, body: Object.freeze({ epoch: body.epoch, sequence: body.sequence, state: state(body.state), ...observation(body) }) });
  }
  return invalid();
}
function expected(value: RunnerRuntimeExpectedTarget): RunnerRuntimeExpectedTarget {
  exact(value, [...TARGET_KEYS, "action", "body"]);
  const pinned = target(Object.fromEntries(TARGET_KEYS.map((key) => [key, value[key]])));
  return Object.freeze({ ...pinned, ...intent(value.action, value.body) });
}
function stateTuple(value: RunnerRuntimeState): unknown[] { return runnerRuntimeStateTuple(value); }

export function runnerRuntimeBodyDigest(action: "acquire", body: RunnerRuntimeAcquireBody): string;
export function runnerRuntimeBodyDigest(action: "heartbeat", body: RunnerRuntimeHeartbeatBody): string;
export function runnerRuntimeBodyDigest(action: RunnerRuntimeAction, body: RunnerRuntimeAcquireBody | RunnerRuntimeHeartbeatBody): string;
export function runnerRuntimeBodyDigest(action: RunnerRuntimeAction, body: RunnerRuntimeAcquireBody | RunnerRuntimeHeartbeatBody): string {
  const checked = intent(action, body);
  const tuple: unknown[] = checked.action === "acquire"
    ? [1, checked.action, checked.body.requestId, ...stateTuple(checked.body.state)]
    : [1, checked.action, checked.body.epoch, checked.body.sequence, ...stateTuple(checked.body.state)];
  if (checked.body.brainObservation) tuple.push("balchemy.local-agent.brain-observation.v1", observationTuple(checked.body.brainObservation));
  // Appended only when present, so older bodies keep their original digest.
  if (checked.body.keystore) tuple.push("balchemy.local-agent.keystore-observation.v2", [checked.body.keystore.lock, checked.body.keystore.exits]);
  return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex");
}

/** `sentAt` (optional): this computer's clock when the nonce request was sent. It only names the cause of an expired nonce (a nonce
 * Balchemy issued more than CLOCK_SKEW_MS before it was requested can only come from a clock difference); it never refuses anything
 * that is otherwise accepted. */
export function validateRunnerRuntimeNonce(value: unknown, expectedTarget: RunnerRuntimeExpectedTarget, now = Date.now(), sentAt?: number): RunnerRuntimeNonce {
  const pinned = expected(expectedTarget);
  exact(value, NONCE_KEYS);
  if (!Number.isFinite(now) || value.version !== 1 || value.purpose !== `balchemy.local-agent.runtime.${pinned.action}.v1`
    || value.audience !== `${pinned.frontendOrigin}/api${PATH}/${pinned.action}` || !matches(value.nonceId, UUID)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.runnerPublicKey !== pinned.runnerPublicKey
    || value.instanceId !== pinned.instanceId || value.action !== pinned.action || !matches(value.nonce, HEX)
    || value.bodyDigest !== runnerRuntimeBodyDigest(pinned.action, pinned.body)) invalid();
  const issued = timestamp(value.issuedAt);
  const expires = timestamp(value.expiresAt);
  if (expires - issued !== 15_000) invalid();
  // Balchemy's issue time ahead of this computer's clock: only a clock difference explains it (time only moves it the other way).
  if (issued > now + CLOCK_SKEW_MS) clockSkew();
  if (expires <= now) {
    if (sentAt !== undefined && Number.isFinite(sentAt) && issued < sentAt - CLOCK_SKEW_MS) clockSkew();
    invalid();
  }
  return Object.freeze({ ...value }) as unknown as RunnerRuntimeNonce;
}

/** Fixed-purpose canonical bytes, never an arbitrary server-supplied signing message. */
export function runnerRuntimeNonceMessage(value: RunnerRuntimeNonce, expectedTarget: RunnerRuntimeExpectedTarget, now = Date.now()): string {
  const nonce = validateRunnerRuntimeNonce(value, expectedTarget, now);
  return JSON.stringify(NONCE_KEYS.map((key) => nonce[key]));
}

export function validateRunnerRuntimeLeaseReceipt(value: unknown, expectedTarget: RunnerRuntimeExpectedTarget, now = Date.now()): RunnerRuntimeLeaseReceipt {
  const pinned = expected(expectedTarget);
  exact(value, RECEIPT_KEYS, ["brainObservation", "keystore"]);
  const observed = observation(value);
  if (JSON.stringify(observed.brainObservation) !== JSON.stringify(pinned.body.brainObservation)
    || JSON.stringify(observed.keystore) !== JSON.stringify(pinned.body.keystore)) invalid();
  const reported = state(value.state);
  if (!Number.isFinite(now) || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.instanceId !== pinned.instanceId
    || !positive(value.epoch) || value.heartbeatIntervalMs !== 10_000 || value.leaseDurationMs !== 30_000
    || JSON.stringify(stateTuple(reported)) !== JSON.stringify(stateTuple(pinned.body.state))) invalid();
  if (pinned.action === "acquire" ? value.sequence !== 0 : value.epoch !== pinned.body.epoch || value.sequence !== pinned.body.sequence) invalid();
  const accepted = timestamp(value.acceptedAt);
  const expires = timestamp(value.leaseExpiresAt);
  const server = timestamp(value.serverTime);
  if (expires - accepted !== 30_000 || server < accepted || expires <= server) invalid();
  // Balchemy's own time against this computer's clock (final audit N5): the one definitive clock comparison of the receipt.
  if (Math.abs(server - now) > CLOCK_SKEW_MS) clockSkew();
  if (expires <= now) invalid();
  return Object.freeze({ ...value, state: reported, ...observed }) as unknown as RunnerRuntimeLeaseReceipt;
}

/** Require the established canonical envelope before the shared client unwraps it. */
async function canonicalResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const text = await readBoundedResponseText(response, 16_384);
  let decoded: unknown;
  try { decoded = JSON.parse(text) as unknown; } catch { return invalid(); }
  exact(decoded, ["success", "data", "meta"], ["message"]);
  if (decoded.success !== true || (decoded.message !== undefined && (typeof decoded.message !== "string" || decoded.message.length > 4096))) invalid();
  exact(decoded.meta, ["timestamp", "compatMode"], ["requestId", "correlationId", "path", "method"]);
  timestamp(decoded.meta.timestamp);
  if (decoded.meta.compatMode !== "canonical") invalid();
  for (const key of ["requestId", "correlationId", "path", "method"] as const) {
    const part = decoded.meta[key];
    if (part !== undefined && (typeof part !== "string" || part.length > (key === "path" ? 512 : key === "method" ? 16 : 256))) invalid();
  }
  return new Response(text, { status: response.status, headers: response.headers });
}

export class RunnerRuntimeClient {
  private readonly http: HttpClient;
  private readonly pinned: RunnerRuntimeTarget;
  private readonly signer: RunnerRuntimeSigner;

  constructor(config: RunnerRuntimeClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = target(Object.fromEntries(TARGET_KEYS.map((key) => [key, config[key]])));
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")) invalid();
    this.signer = config.signer;
    const transport = config.fetchFn ?? fetch;
    this.http = new HttpClient({ baseUrl: config.apiBaseUrl, timeoutMs: config.timeoutMs ?? 5_000, retry: { maxAttempts: 1 },
      fetchFn: async (input, init) => canonicalResponse(await transport(input, { ...init, credentials: "omit", redirect: "error" })),
    });
  }

  /** A new requestId is a new intent. Explicit same-body calls recover using a fresh nonce. */
  acquire(body: RunnerRuntimeAcquireBody): Promise<RunnerRuntimeLeaseReceipt> {
    return this.submit(intent("acquire", body));
  }

  /** Caller persists the exact next sequence/body before dispatch; the server fences ordering. */
  heartbeat(body: RunnerRuntimeHeartbeatBody): Promise<RunnerRuntimeLeaseReceipt> {
    return this.submit(intent("heartbeat", body));
  }

  private async submit(frozen: RunnerRuntimeActionBody): Promise<RunnerRuntimeLeaseReceipt> {
    const pinned: RunnerRuntimeExpectedTarget = Object.freeze({ ...this.pinned, ...frozen });
    const sentAt = Date.now();
    const result = await this.http.post<unknown>(`${PATH}/nonce`, {
      agentId: pinned.agentId, bindingDigest: pinned.bindingDigest, instanceId: pinned.instanceId,
      action: pinned.action, bodyDigest: runnerRuntimeBodyDigest(pinned.action, pinned.body),
    }, { kind: "side_effecting", operation: "local-agent:runtime-nonce" });
    const nonce = validateRunnerRuntimeNonce(result, pinned, Date.now(), sentAt);
    let signature: string;
    try { signature = await this.signer(nonce, pinned); }
    catch { return invalid(); }
    validateRunnerRuntimeNonce(nonce, pinned, Date.now(), sentAt);
    if (!base64(signature, 64)) invalid();
    const receipt = await this.http.post<unknown>(`${PATH}/${pinned.action}`, {
      nonceId: nonce.nonceId, runnerSignature: signature, body: pinned.body,
    }, { kind: "side_effecting", operation: `local-agent:runtime-${pinned.action}` });
    return validateRunnerRuntimeLeaseReceipt(receipt, pinned);
  }
}
