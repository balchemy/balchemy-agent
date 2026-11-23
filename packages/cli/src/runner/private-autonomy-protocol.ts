/** Owner-local call allowance control. No credential, counter-reset or execution operation. */
import { isId, MAX_FRAME_BYTES } from "./protocol.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { parsePrivateAutonomyPolicyInput, parsePrivateAutonomyStatus, PRIVATE_AUTONOMY_ERRORS,
  type PrivateAutonomyPolicyInput, type PrivateAutonomyStatus } from "./private-autonomy.js";

export interface PrivateAutonomyBinding {
  channel: "private_autonomy"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateAutonomyRequest = PrivateAutonomyBinding & (
  /** A2a: `passphrase` (optional) is the trading-wallet socket proof of a raising change; the daemon decides whether it is required. */
  { action: "status" } | ({ action: "update"; passphrase?: string } & PrivateAutonomyPolicyInput)
);
export const PRIVATE_AUTONOMY_CHANNEL_ERRORS = [...PRIVATE_AUTONOMY_ERRORS,
  "profile_conflict", "instance_conflict", "closing", "busy", "call_allowance_unavailable",
  // A2a socket proof (private-socket-proof.ts); `cancelled` is already a domain code.
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled"] as const;
export type PrivateAutonomyChannelError = typeof PRIVATE_AUTONOMY_CHANNEL_ERRORS[number];
export type PrivateAutonomyData = { kind: "status"; status: PrivateAutonomyStatus }
  | { kind: "update"; operationId: string; expectedRevision: number; status: PrivateAutonomyStatus };
export type PrivateAutonomyResponse = PrivateAutonomyBinding & (
  { ok: true; data: PrivateAutonomyData } | { ok: false; error: PrivateAutonomyChannelError }
);
const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
function invalid(): never { throw new Error("Invalid private model allowance response or request"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_autonomy" || value.version !== 1
    || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
export function parsePrivateAutonomyRequest(value: unknown): PrivateAutonomyRequest {
  exact(value, [...BINDING, "action"], ["operationId", "expectedRevision", "dailyCallLimit", "passphrase"]); binding(value);
  if (value.action === "status") exact(value, [...BINDING, "action"]);
  else if (value.action === "update") {
    exact(value, [...BINDING, "action", "operationId", "expectedRevision", "dailyCallLimit"], ["passphrase"]);
    if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
    parsePrivateAutonomyPolicyInput({ operationId: value.operationId, expectedRevision: value.expectedRevision, dailyCallLimit: value.dailyCallLimit });
  } else invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateAutonomyRequest;
}
export function parsePrivateAutonomyResponse(value: unknown): PrivateAutonomyResponse {
  exact(value, [...BINDING, "ok"], ["data", "error"]); binding(value);
  if (value.ok === true) {
    exact(value, [...BINDING, "ok", "data"]);
    exact(value.data, ["kind", "status"], ["operationId", "expectedRevision"]);
    const status = parsePrivateAutonomyStatus(value.data.status);
    if (status.agentId !== value.agentId) invalid();
    if (value.data.kind === "status") exact(value.data, ["kind", "status"]);
    else if (value.data.kind === "update") {
      exact(value.data, ["kind", "status", "operationId", "expectedRevision"]);
      const input = parsePrivateAutonomyPolicyInput({ operationId: value.data.operationId,
        expectedRevision: value.data.expectedRevision, dailyCallLimit: status.policy.dailyCallLimit });
      if (status.policy.revision !== input.expectedRevision + 1) invalid();
    } else invalid();
  } else if (value.ok === false) {
    exact(value, [...BINDING, "ok", "error"]);
    if (!PRIVATE_AUTONOMY_CHANNEL_ERRORS.includes(value.error as PrivateAutonomyChannelError)) invalid();
  } else invalid();
  bounded(value); return structuredClone(value) as unknown as PrivateAutonomyResponse;
}
function responseBinding(request: PrivateAutonomyRequest): PrivateAutonomyBinding {
  return { channel: "private_autonomy", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId };
}
export function privateAutonomySuccess(request: PrivateAutonomyRequest, data: PrivateAutonomyData): PrivateAutonomyResponse {
  return parsePrivateAutonomyResponse({ ...responseBinding(request), ok: true, data });
}
export function privateAutonomyFailure(request: PrivateAutonomyRequest, error: PrivateAutonomyChannelError): PrivateAutonomyResponse {
  return parsePrivateAutonomyResponse({ ...responseBinding(request), ok: false, error });
}
export function validatePrivateAutonomyReply(request: PrivateAutonomyRequest, value: unknown): PrivateAutonomyResponse {
  const response = parsePrivateAutonomyResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    if (request.action === "status") { if (response.data.kind !== "status") invalid(); }
    else if (response.data.kind !== "update" || response.data.operationId !== request.operationId
      || response.data.expectedRevision !== request.expectedRevision
      || response.data.status.policy.dailyCallLimit !== request.dailyCallLimit) invalid();
  }
  return response;
}
