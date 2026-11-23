/** Owner-confirmed sizing policy only. No model, signing or execution authority. */
import { isId, MAX_FRAME_BYTES } from "./protocol.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { parsePrivateChangeEntries, type PrivateChangeEntries } from "./private-change-entries.js";
import { parsePrivateBuyAmountPolicyInput, parsePrivateSizingStatus, parsePrivateSolAmount,
  type PrivateBuyAmountPolicyInput, type PrivateSizingStatus } from "./private-sizing.js";

export interface PrivateSizingBinding {
  channel: "private_sizing"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateSizingRequest = PrivateSizingBinding & (
  /** A2a: `passphrase` (optional) is the trading-wallet socket proof of a raising change; the daemon decides whether it is required. */
  { action: "status" } | ({ action: "update"; passphrase?: string } & PrivateBuyAmountPolicyInput)
);
export const PRIVATE_SIZING_CHANNEL_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent",
  "revision_conflict", "rule_revision_conflict", "operation_conflict", "clock_rollback", "state_unavailable", "closing", "busy", "cancelled",
  // A2a socket proof (private-socket-proof.ts).
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled"] as const;
export type PrivateSizingChannelError = typeof PRIVATE_SIZING_CHANNEL_ERRORS[number];
export type PrivateSizingData = { kind: "status"; status: PrivateSizingStatus }
  /** `entries` only when the agent was armed when the save began (owner decision of 17 Nov 2026, private-change-entries.ts). */
  | { kind: "update"; operationId: string; expectedRevision: number; status: PrivateSizingStatus; entries?: PrivateChangeEntries };
export type PrivateSizingResponse = PrivateSizingBinding & (
  { ok: true; data: PrivateSizingData } | { ok: false; error: PrivateSizingChannelError }
);
const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
function invalid(): never { throw new Error("Invalid private sizing request or response"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_sizing" || value.version !== 1
    || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
export function parsePrivateSizingRequest(value: unknown): PrivateSizingRequest {
  exact(value, [...BINDING, "action"], ["operationId", "expectedRevision", "expectedRuleRevisionId", "amountSol", "slippageBps", "passphrase"]); binding(value);
  if (value.action === "status") exact(value, [...BINDING, "action"]);
  else if (value.action === "update") {
    exact(value, [...BINDING, "action", "operationId", "expectedRevision", "expectedRuleRevisionId", "amountSol", "slippageBps"], ["passphrase"]);
    if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
    const input = parsePrivateBuyAmountPolicyInput({ operationId: value.operationId, expectedRevision: value.expectedRevision,
      expectedRuleRevisionId: value.expectedRuleRevisionId, amountSol: value.amountSol, slippageBps: value.slippageBps });
    bounded(value); return Object.freeze({ ...structuredClone(value), ...input }) as unknown as PrivateSizingRequest;
  } else invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateSizingRequest;
}
export function parsePrivateSizingResponse(value: unknown): PrivateSizingResponse {
  exact(value, [...BINDING, "ok"], ["data", "error"]); binding(value);
  if (value.ok === true) {
    exact(value, [...BINDING, "ok", "data"]); exact(value.data, ["kind", "status"], ["operationId", "expectedRevision", "entries"]);
    const status = parsePrivateSizingStatus(value.data.status, { localProfileId: value.localProfileId as string, agentId: value.agentId as string });
    let entries: PrivateChangeEntries | undefined;
    if (value.data.kind === "status") exact(value.data, ["kind", "status"]);
    else if (value.data.kind === "update") {
      exact(value.data, ["kind", "status", "operationId", "expectedRevision"], ["entries"]);
      if (!status.policy) invalid();
      const input = parsePrivateBuyAmountPolicyInput({ operationId: value.data.operationId, expectedRevision: value.data.expectedRevision,
        expectedRuleRevisionId: status.policy.configuredAgainstRuleRevisionId, amountSol: status.policy.amountSol, slippageBps: status.policy.slippageBps });
      if (status.policy.revision !== input.expectedRevision + 1) invalid();
      if (Object.hasOwn(value.data, "entries")) entries = parsePrivateChangeEntries(value.data.entries);
    } else invalid();
    bounded(value);
    return { ...structuredClone(value), data: { ...structuredClone(value.data), status, ...(entries ? { entries } : {}) } } as unknown as PrivateSizingResponse;
  }
  if (value.ok !== false) invalid();
  exact(value, [...BINDING, "ok", "error"]);
  if (!PRIVATE_SIZING_CHANNEL_ERRORS.includes(value.error as PrivateSizingChannelError)) invalid();
  bounded(value); return structuredClone(value) as unknown as PrivateSizingResponse;
}
function responseBinding(request: PrivateSizingRequest): PrivateSizingBinding {
  return { channel: "private_sizing", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId };
}
export function privateSizingSuccess(request: PrivateSizingRequest, data: PrivateSizingData): PrivateSizingResponse {
  return parsePrivateSizingResponse({ ...responseBinding(request), ok: true, data });
}
export function privateSizingFailure(request: PrivateSizingRequest, error: PrivateSizingChannelError): PrivateSizingResponse {
  return parsePrivateSizingResponse({ ...responseBinding(request), ok: false, error });
}
export function validatePrivateSizingReply(request: PrivateSizingRequest, value: unknown): PrivateSizingResponse {
  const response = parsePrivateSizingResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    if (request.action === "status") { if (response.data.kind !== "status") invalid(); }
    else {
      const amount = parsePrivateSolAmount(request.amountSol); const policy = response.data.status.policy;
      if (response.data.kind !== "update" || response.data.operationId !== request.operationId
        || response.data.expectedRevision !== request.expectedRevision || !policy
        || policy.configuredAgainstRuleRevisionId !== request.expectedRuleRevisionId
        || policy.amountSol !== amount.amountSol || policy.amountBaseUnits !== amount.amountBaseUnits
        || policy.slippageBps !== request.slippageBps) invalid();
    }
  }
  return response;
}
