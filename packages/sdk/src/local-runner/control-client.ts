import { createHash } from "node:crypto";
import { HttpClient } from "../client/http-client";
import { AgentSdkError } from "../errors/agent-sdk-error";
import { readBoundedResponseText } from "../utils/redaction";
import { parseRunnerRuntimeState, runnerRuntimeStateTuple, type RunnerRuntimeState, type RunnerRuntimeTarget } from "./runtime-client";

export type RunnerControlTarget = RunnerRuntimeTarget;
export type RunnerControlState = RunnerRuntimeState;
export type RunnerControlAction = "pause" | "resume_shadow" | "disarm" | "stop";
export type RunnerControlProofAction = "poll" | "ack";
export interface RunnerControlCommand {
  version: 1;
  purpose: "balchemy.local-agent.control.v1";
  commandId: string;
  requestId: string;
  agentId: string;
  bindingDigest: string;
  action: RunnerControlAction;
  targetInstanceId: string;
  targetEpoch: number;
  expectedVersion: number;
  beforeState: RunnerControlState;
  issuedAt: string;
  expiresAt: string;
  commandDigest: string;
}
export type RunnerControlObservation =
  | { outcome: "applied"; state: RunnerControlState }
  | { outcome: "rejected"; code: "version_conflict"; state: RunnerControlState }
  | { outcome: "unknown"; reason: "receipt_missing" | "receipt_conflict" | "state_unavailable" | "journal_full" };
export interface RunnerControlPollBody { epoch: number; recoveryCursor: string | null }
export interface RunnerControlAckBody {
  epoch: number;
  commandId: string;
  commandDigest: string;
  localReceiptId: string;
  observation: RunnerControlObservation;
}
export type RunnerControlOperation =
  | { action: "poll"; body: RunnerControlPollBody }
  | { action: "ack"; command: RunnerControlCommand; body: RunnerControlAckBody };
export type RunnerControlExpectedTarget = RunnerControlTarget & RunnerControlOperation;
export interface RunnerControlNonce {
  version: 1;
  purpose: "balchemy.local-agent.control.poll.v1" | "balchemy.local-agent.control.ack.v1";
  audience: string;
  nonceId: string;
  agentId: string;
  bindingDigest: string;
  runnerPublicKey: string;
  instanceId: string;
  epoch: number;
  action: RunnerControlProofAction;
  bodyDigest: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}
export interface RunnerControlPollResponse {
  delivery: { mode: "apply_or_recover"; command: RunnerControlCommand } | null;
  recoveries: Array<{ mode: "recover_only"; command: RunnerControlCommand }>;
  nextRecoveryCursor: string | null;
  serverTime: string;
  pollIntervalMs: 5000;
}
export interface RunnerControlRecord {
  command: RunnerControlCommand;
  status: "pending" | "delivered" | "applied" | "rejected" | "expired" | "unknown";
  deliveredAt: string | null;
  observedAt: string | null;
  observation: RunnerControlObservation | null;
}
export interface RunnerControlAckResponse { item: RunnerControlRecord; serverTime: string }
/** The callback signs only runnerControlNonceMessage after checking the pinned operation. */
export type RunnerControlSigner = (nonce: Readonly<RunnerControlNonce>, expectedTarget: RunnerControlExpectedTarget) => string | Promise<string>;
export interface RunnerControlClientConfig extends RunnerControlTarget {
  apiBaseUrl: string;
  signer: RunnerControlSigner;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

const PATH = "/nest/local-agents/control";
const PURPOSE = "balchemy.local-agent.control.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const CURSOR = /^[0-9a-f]{24}$/;
const TARGET_KEYS = ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "instanceId"] as const;
const COMMAND_KEYS = ["version", "purpose", "commandId", "requestId", "agentId", "bindingDigest", "action", "targetInstanceId", "targetEpoch", "expectedVersion", "beforeState", "issuedAt", "expiresAt"] as const;
const NONCE_KEYS = ["version", "purpose", "audience", "nonceId", "agentId", "bindingDigest", "runnerPublicKey", "instanceId", "epoch", "action", "bodyDigest", "nonce", "issuedAt", "expiresAt"] as const;
const ACTIONS = ["pause", "resume_shadow", "disarm", "stop"] as const;
const UNKNOWN_REASONS = ["receipt_missing", "receipt_conflict", "state_unavailable", "journal_full"] as const;
const CLOCK_SKEW_MS = 5000;

function invalid(): never {
  throw new AgentSdkError({ code: "invalid_response", message: "Invalid local-agent control protocol", details: { retryable: false } });
}
function exact(value: unknown, required: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!required.every((key) => Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || (!required.includes(key) && !optional.includes(key)))
    || Object.values(descriptors).some((descriptor) => !("value" in descriptor))) invalid();
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
function clock(value: unknown, now: number): number {
  const server = timestamp(value);
  if (!Number.isFinite(now) || Math.abs(server - now) > CLOCK_SKEW_MS) invalid();
  return server;
}
function target(value: unknown): RunnerControlTarget {
  exact(value, TARGET_KEYS);
  if (typeof value.frontendOrigin !== "string" || !matches(value.agentId, UUID) || !matches(value.instanceId, UUID)
    || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32)) invalid();
  try {
    const url = new URL(value.frontendOrigin);
    if (url.origin !== value.frontendOrigin || url.username || url.password ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  } catch { invalid(); }
  return Object.freeze({ ...value }) as unknown as RunnerControlTarget;
}
function state(value: unknown): RunnerControlState { return parseRunnerRuntimeState(value, invalid); }
function stateTuple(value: RunnerControlState): unknown[] { return runnerRuntimeStateTuple(value); }
function digest(tuple: unknown[]): string { return createHash("sha256").update(JSON.stringify(tuple), "utf8").digest("hex"); }
function commandFields(value: unknown): Omit<RunnerControlCommand, "commandDigest"> {
  exact(value, COMMAND_KEYS);
  const beforeState = state(value.beforeState);
  if (value.version !== 1 || value.purpose !== PURPOSE || !matches(value.commandId, UUID) || !matches(value.requestId, UUID)
    || !matches(value.agentId, UUID) || !matches(value.bindingDigest, HEX) || !matches(value.targetInstanceId, UUID)
    || !ACTIONS.includes(value.action as RunnerControlAction) || !positive(value.targetEpoch) || !positive(value.expectedVersion)
    || value.expectedVersion !== beforeState.version) invalid();
  const lifetime = timestamp(value.expiresAt) - timestamp(value.issuedAt);
  if (lifetime <= 0 || lifetime > 30_000) invalid();
  return Object.freeze({ ...value, beforeState }) as unknown as Omit<RunnerControlCommand, "commandDigest">;
}
function commandTuple(value: Omit<RunnerControlCommand, "commandDigest">): unknown[] {
  return [value.version, value.purpose, value.commandId, value.requestId, value.agentId, value.bindingDigest,
    value.action, value.targetInstanceId, value.targetEpoch, value.expectedVersion, stateTuple(value.beforeState), value.issuedAt, value.expiresAt];
}
export function runnerControlCommandDigest(value: Omit<RunnerControlCommand, "commandDigest">): string { return digest(commandTuple(commandFields(value))); }
export function runnerControlLocalReceiptId(commandDigest: string): string {
  if (!matches(commandDigest, HEX)) invalid();
  return `web:${commandDigest}`;
}
/** Validates immutable identity; only a poll delivery permits considering application. */
export function validateRunnerControlCommand(value: unknown, expectedTarget: RunnerControlTarget, now = Date.now()): RunnerControlCommand {
  const pinned = target(expectedTarget);
  exact(value, [...COMMAND_KEYS, "commandDigest"]);
  const fields = commandFields(Object.fromEntries(COMMAND_KEYS.map((key) => [key, value[key]])));
  if (!Number.isFinite(now) || fields.agentId !== pinned.agentId || fields.bindingDigest !== pinned.bindingDigest
    || timestamp(fields.issuedAt) > now + CLOCK_SKEW_MS || value.commandDigest !== digest(commandTuple(fields))) invalid();
  return Object.freeze({ ...fields, commandDigest: value.commandDigest }) as RunnerControlCommand;
}
function observation(value: unknown): RunnerControlObservation {
  exact(value, ["outcome"], ["state", "code", "reason"]);
  if (value.outcome === "unknown") {
    exact(value, ["outcome", "reason"]);
    if (!UNKNOWN_REASONS.includes(value.reason as typeof UNKNOWN_REASONS[number])) invalid();
    return Object.freeze({ ...value }) as unknown as RunnerControlObservation;
  }
  if (value.outcome === "applied") {
    exact(value, ["outcome", "state"]);
    return Object.freeze({ outcome: "applied", state: state(value.state) });
  }
  if (value.outcome === "rejected") {
    exact(value, ["outcome", "code", "state"]);
    if (value.code !== "version_conflict") invalid();
    return Object.freeze({ outcome: "rejected", code: "version_conflict", state: state(value.state) });
  }
  return invalid();
}
function checkedObservation(value: unknown, command: RunnerControlCommand): RunnerControlObservation {
  const result = observation(value);
  if (result.outcome === "unknown") return result;
  if (result.outcome === "rejected") {
    if (result.state.version === command.expectedVersion) invalid();
    return result;
  }
  const after = result.state;
  const before = command.beforeState;
  if (after.version !== command.expectedVersion + 1 ||
    // Pause of an armed agent keeps it live_armed with new entries paused; any other pause lands on paused.
    (command.action === "pause" && (before.mode === "live_armed"
      ? after.mode !== "live_armed" || after.entries !== "paused" || after.lifecycle !== before.lifecycle
      : after.mode !== "paused" || after.lifecycle !== before.lifecycle)) ||
    (command.action === "disarm" && (after.mode !== (before.mode === "live_armed" ? "live_unarmed" : before.mode) || after.lifecycle !== before.lifecycle)) ||
    (command.action === "resume_shadow" && (after.mode !== "shadow" || after.lifecycle !== "idle")) ||
    (command.action === "stop" && (after.mode !== "paused" || after.lifecycle !== "stopped"))) invalid();
  return result;
}
function observationTuple(value: RunnerControlObservation): unknown[] {
  return [value.outcome, value.outcome === "rejected" ? value.code : null, value.outcome === "unknown" ? value.reason : null,
    value.outcome === "unknown" ? null : stateTuple(value.state)];
}
function body(action: "poll", value: unknown): RunnerControlPollBody;
function body(action: "ack", value: unknown): RunnerControlAckBody;
function body(action: RunnerControlProofAction, value: unknown): RunnerControlPollBody | RunnerControlAckBody;
function body(action: RunnerControlProofAction, value: unknown): RunnerControlPollBody | RunnerControlAckBody {
  if (action === "poll") {
    exact(value, ["epoch", "recoveryCursor"]);
    if (!positive(value.epoch) || (value.recoveryCursor !== null && !matches(value.recoveryCursor, CURSOR))) invalid();
    return Object.freeze({ epoch: value.epoch, recoveryCursor: value.recoveryCursor }) as RunnerControlPollBody;
  }
  if (action === "ack") {
    exact(value, ["epoch", "commandId", "commandDigest", "localReceiptId", "observation"]);
    if (!positive(value.epoch) || !matches(value.commandId, UUID) || !matches(value.commandDigest, HEX)
      || value.localReceiptId !== runnerControlLocalReceiptId(value.commandDigest)) invalid();
    return Object.freeze({ ...value, observation: observation(value.observation) }) as unknown as RunnerControlAckBody;
  }
  return invalid();
}
export function runnerControlBodyDigest(action: "poll", value: RunnerControlPollBody): string;
export function runnerControlBodyDigest(action: "ack", value: RunnerControlAckBody): string;
export function runnerControlBodyDigest(action: RunnerControlProofAction, value: RunnerControlPollBody | RunnerControlAckBody): string;
export function runnerControlBodyDigest(action: RunnerControlProofAction, value: RunnerControlPollBody | RunnerControlAckBody): string {
  if (action === "poll") {
    const checked = body(action, value);
    return digest([1, action, checked.epoch, checked.recoveryCursor]);
  }
  const checked = body(action, value);
  if (!("commandId" in checked)) invalid();
  return digest([1, action, checked.epoch, checked.commandId, checked.commandDigest, checked.localReceiptId, ...observationTuple(checked.observation)]);
}
function expected(value: RunnerControlExpectedTarget, now: number): RunnerControlExpectedTarget {
  exact(value, [...TARGET_KEYS, "action", "body"], ["command"]);
  exact(value, [...TARGET_KEYS, "action", "body", ...(value.action === "ack" ? ["command"] : [])]);
  const pinned = target(Object.fromEntries(TARGET_KEYS.map((key) => [key, value[key]])));
  if (value.action === "poll") return Object.freeze({ ...pinned, action: "poll", body: body("poll", value.body) });
  if (value.action !== "ack") invalid();
  const command = validateRunnerControlCommand(value.command, pinned, now);
  const ack = body("ack", value.body);
  if (ack.commandId !== command.commandId || ack.commandDigest !== command.commandDigest) invalid();
  return Object.freeze({ ...pinned, action: "ack", command,
    body: Object.freeze({ ...ack, observation: checkedObservation(ack.observation, command) }) });
}
export function validateRunnerControlNonce(value: unknown, expectedTarget: RunnerControlExpectedTarget, now = Date.now()): RunnerControlNonce {
  const pinned = expected(expectedTarget, now);
  exact(value, NONCE_KEYS);
  if (!Number.isFinite(now) || value.version !== 1 || value.purpose !== `balchemy.local-agent.control.${pinned.action}.v1`
    || value.audience !== `${pinned.frontendOrigin}/api${PATH}/${pinned.action}` || !matches(value.nonceId, UUID)
    || value.agentId !== pinned.agentId || value.bindingDigest !== pinned.bindingDigest || value.runnerPublicKey !== pinned.runnerPublicKey
    || value.instanceId !== pinned.instanceId || value.epoch !== pinned.body.epoch || value.action !== pinned.action
    || value.bodyDigest !== runnerControlBodyDigest(pinned.action, pinned.body) || !matches(value.nonce, HEX)) invalid();
  const issued = timestamp(value.issuedAt);
  const expires = timestamp(value.expiresAt);
  if (issued > now + CLOCK_SKEW_MS || expires <= now || expires - issued !== 15_000) invalid();
  return Object.freeze({ ...value }) as unknown as RunnerControlNonce;
}
export function runnerControlNonceMessage(value: RunnerControlNonce, expectedTarget: RunnerControlExpectedTarget, now = Date.now()): string {
  const checked = validateRunnerControlNonce(value, expectedTarget, now);
  return JSON.stringify(NONCE_KEYS.map((key) => checked[key]));
}
export function validateRunnerControlPollResponse(value: unknown, expectedTarget: RunnerControlExpectedTarget, now = Date.now()): RunnerControlPollResponse {
  const pinned = expected(expectedTarget, now);
  if (pinned.action !== "poll") invalid();
  exact(value, ["delivery", "recoveries", "nextRecoveryCursor", "serverTime", "pollIntervalMs"]);
  const server = clock(value.serverTime, now);
  if (value.pollIntervalMs !== 5000 || !Array.isArray(value.recoveries) || value.recoveries.length > 10
    || (value.nextRecoveryCursor !== null && (!matches(value.nextRecoveryCursor, CURSOR)
      || (pinned.body.recoveryCursor !== null && value.nextRecoveryCursor <= pinned.body.recoveryCursor)))) invalid();
  let delivery: RunnerControlPollResponse["delivery"] = null;
  if (value.delivery !== null) {
    exact(value.delivery, ["mode", "command"]);
    const command = validateRunnerControlCommand(value.delivery.command, targetPart(pinned), server);
    if (value.delivery.mode !== "apply_or_recover" || command.targetInstanceId !== pinned.instanceId || command.targetEpoch !== pinned.body.epoch
      || timestamp(command.issuedAt) > server || timestamp(command.expiresAt) <= server || timestamp(command.expiresAt) <= now) invalid();
    delivery = Object.freeze({ mode: "apply_or_recover", command });
  }
  const recoveries = value.recoveries.map((entry) => {
    exact(entry, ["mode", "command"]);
    const command = validateRunnerControlCommand(entry.command, targetPart(pinned), server);
    if (entry.mode !== "recover_only" || timestamp(command.issuedAt) > server) invalid();
    return Object.freeze({ mode: "recover_only" as const, command });
  });
  const commands = [...(delivery ? [delivery.command] : []), ...recoveries.map((entry) => entry.command)];
  if (new Set(commands.map((entry) => entry.commandId)).size !== commands.length || new Set(commands.map((entry) => entry.requestId)).size !== commands.length) invalid();
  Object.freeze(recoveries);
  return Object.freeze({ delivery, recoveries, nextRecoveryCursor: value.nextRecoveryCursor, serverTime: value.serverTime, pollIntervalMs: 5000 }) as RunnerControlPollResponse;
}
function targetPart(value: RunnerControlTarget): RunnerControlTarget {
  return Object.fromEntries(TARGET_KEYS.map((key) => [key, value[key]])) as unknown as RunnerControlTarget;
}
/** Returns the stored outcome. An UNKNOWN submission may reconcile to an existing
 * terminal receipt; terminal submissions still require identical observations. */
export function validateRunnerControlAckResponse(value: unknown, expectedTarget: RunnerControlExpectedTarget, now = Date.now()): RunnerControlAckResponse {
  const pinned = expected(expectedTarget, now);
  if (pinned.action !== "ack") invalid();
  exact(value, ["item", "serverTime"]);
  const server = clock(value.serverTime, now);
  exact(value.item, ["command", "status", "deliveredAt", "observedAt", "observation"]);
  const command = validateRunnerControlCommand(value.item.command, targetPart(pinned), server);
  if (command.commandDigest !== pinned.command.commandDigest || JSON.stringify(commandTuple(command)) !== JSON.stringify(commandTuple(pinned.command))) invalid();
  const observed = checkedObservation(value.item.observation, command);
  if (value.item.status !== observed.outcome || timestamp(command.issuedAt) > server) invalid();
  const delivered = timestamp(value.item.deliveredAt);
  const observedAt = timestamp(value.item.observedAt);
  if (delivered < timestamp(command.issuedAt) || delivered >= timestamp(command.expiresAt)
    || observedAt < delivered || observedAt > server || delivered > server) invalid();
  const canonicalTerminal = pinned.body.observation.outcome === "unknown" && observed.outcome !== "unknown";
  if (!canonicalTerminal && JSON.stringify(observationTuple(observed)) !== JSON.stringify(observationTuple(pinned.body.observation))) invalid();
  return Object.freeze({ item: Object.freeze({ command, status: value.item.status, deliveredAt: value.item.deliveredAt,
    observedAt: value.item.observedAt, observation: observed }), serverTime: value.serverTime }) as RunnerControlAckResponse;
}
async function canonicalResponse(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const text = await readBoundedResponseText(response, 65_536);
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
export class RunnerControlClient {
  private readonly http: HttpClient;
  private readonly pinned: RunnerControlTarget;
  private readonly signer: RunnerControlSigner;
  private readonly timeoutMs: number;
  constructor(config: RunnerControlClientConfig) {
    exact(config, [...TARGET_KEYS, "apiBaseUrl", "signer"], ["timeoutMs", "fetchFn"]);
    this.pinned = target(targetPart(config));
    if (config.apiBaseUrl !== `${this.pinned.frontendOrigin}/api` || typeof config.signer !== "function"
      || (config.fetchFn !== undefined && typeof config.fetchFn !== "function")
      || (config.timeoutMs !== undefined && (!positive(config.timeoutMs) || config.timeoutMs > 5000))) invalid();
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.signer = config.signer;
    const transport = config.fetchFn ?? fetch;
    this.http = new HttpClient({ baseUrl: config.apiBaseUrl, timeoutMs: this.timeoutMs, retry: { maxAttempts: 1 },
      fetchFn: async (input, init) => canonicalResponse(await transport(input, { ...init, credentials: "omit", redirect: "error" })),
    });
  }
  /** No scheduling or implicit retry. Caller applies the lease/RTT deadline fence. */
  async poll(input: RunnerControlPollBody): Promise<RunnerControlPollResponse> {
    const operation = expected({ ...this.pinned, action: "poll", body: input }, Date.now());
    return validateRunnerControlPollResponse(await this.submit(operation), operation);
  }
  /** Explicit retries preserve the exact body and acquire a fresh nonce. */
  async ack(command: RunnerControlCommand, input: RunnerControlAckBody): Promise<RunnerControlAckResponse> {
    const operation = expected({ ...this.pinned, action: "ack", command, body: input }, Date.now());
    return validateRunnerControlAckResponse(await this.submit(operation), operation);
  }
  private async submit(operation: RunnerControlExpectedTarget): Promise<unknown> {
    const result = await this.http.post<unknown>(`${PATH}/nonce`, {
      agentId: operation.agentId, bindingDigest: operation.bindingDigest, instanceId: operation.instanceId, epoch: operation.body.epoch,
      action: operation.action, bodyDigest: runnerControlBodyDigest(operation.action, operation.body),
    }, { kind: "side_effecting", operation: "local-agent:control-nonce" });
    const nonce = validateRunnerControlNonce(result, operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let signature: string;
    try {
      signature = await Promise.race([
        Promise.resolve().then(() => this.signer(nonce, operation)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Control signing timed out")),
          Math.min(this.timeoutMs, timestamp(nonce.expiresAt) - Date.now())); }),
      ]);
    } catch { return invalid(); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    validateRunnerControlNonce(nonce, operation);
    if (!base64(signature, 64)) invalid();
    return this.http.post<unknown>(`${PATH}/${operation.action}`, {
      nonceId: nonce.nonceId, runnerSignature: signature, body: operation.body,
    }, { kind: "side_effecting", operation: `local-agent:control-${operation.action}` });
  }
}
