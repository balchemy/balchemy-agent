/** Owner-local daily AI budget control (`runner budget`). No credential, spend reset or execution operation. */
import { isId, MAX_FRAME_BYTES } from "./protocol.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { parsePrivateModelBudgetPolicyInput, parsePrivateModelBudgetStatus, parsePrivateModelCapturedPrice, PRIVATE_MODEL_BUDGET_ERRORS,
  type PrivateModelBudgetPolicyInput, type PrivateModelBudgetStatus, type PrivateModelCapturedPrice } from "./private-model-budget.js";

export interface PrivateModelBudgetBinding {
  channel: "private_model_budget"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateModelBudgetRequest = PrivateModelBudgetBinding & (
  /** A2a: `passphrase` (optional, update and price) is the trading-wallet socket proof of a raising change; the daemon decides. */
  { action: "status" } | ({ action: "update"; passphrase?: string } & PrivateModelBudgetPolicyInput)
  /** Phase 2: stores the catalog price of the agent's OpenRouter model; the reply is the status (with `modelPrice`). */
  | ({ action: "price"; passphrase?: string } & PrivateModelCapturedPrice)
);
export const PRIVATE_MODEL_BUDGET_CHANNEL_ERRORS = [...PRIVATE_MODEL_BUDGET_ERRORS, "profile_conflict", "instance_conflict",
  // A2a socket proof (private-socket-proof.ts).
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "busy", "cancelled"] as const;
export type PrivateModelBudgetChannelError = typeof PRIVATE_MODEL_BUDGET_CHANNEL_ERRORS[number];
export type PrivateModelBudgetData = { kind: "status"; status: PrivateModelBudgetStatus }
  | { kind: "update"; operationId: string; expectedRevision: number; status: PrivateModelBudgetStatus };
export type PrivateModelBudgetResponse = PrivateModelBudgetBinding & (
  { ok: true; data: PrivateModelBudgetData } | { ok: false; error: PrivateModelBudgetChannelError }
);
const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
function invalid(): never { throw new Error("Invalid private model budget response or request"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_model_budget" || value.version !== 1
    || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
function status(value: unknown): PrivateModelBudgetStatus {
  try { return parsePrivateModelBudgetStatus(value); } catch { return invalid(); }
}
function policyInput(value: unknown): PrivateModelBudgetPolicyInput {
  try { return parsePrivateModelBudgetPolicyInput(value); } catch { return invalid(); }
}
export function parsePrivateModelBudgetRequest(value: unknown): PrivateModelBudgetRequest {
  exact(value, [...BINDING, "action"], ["operationId", "expectedRevision", "dailyLimitMicroUsd", "provider", "model", "inputMicroUsdPerMillion",
    "outputMicroUsdPerMillion", "passphrase"]); binding(value);
  if (value.action === "status") exact(value, [...BINDING, "action"]);
  else if (value.action === "price") {
    exact(value, [...BINDING, "action", "provider", "model", "inputMicroUsdPerMillion", "outputMicroUsdPerMillion"], ["passphrase"]);
    try { parsePrivateModelCapturedPrice({ provider: value.provider, model: value.model, inputMicroUsdPerMillion: value.inputMicroUsdPerMillion,
      outputMicroUsdPerMillion: value.outputMicroUsdPerMillion }); } catch { invalid(); }
  }
  else if (value.action === "update") {
    exact(value, [...BINDING, "action", "operationId", "expectedRevision", "dailyLimitMicroUsd"], ["passphrase"]);
    policyInput({ operationId: value.operationId, expectedRevision: value.expectedRevision, dailyLimitMicroUsd: value.dailyLimitMicroUsd });
  } else invalid();
  if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateModelBudgetRequest;
}
export function parsePrivateModelBudgetResponse(value: unknown): PrivateModelBudgetResponse {
  exact(value, [...BINDING, "ok"], ["data", "error"]); binding(value);
  if (value.ok === true) {
    exact(value, [...BINDING, "ok", "data"]);
    exact(value.data, ["kind", "status"], ["operationId", "expectedRevision"]);
    const parsed = status(value.data.status);
    if (parsed.agentId !== value.agentId) invalid();
    if (value.data.kind === "status") exact(value.data, ["kind", "status"]);
    else if (value.data.kind === "update") {
      exact(value.data, ["kind", "status", "operationId", "expectedRevision"]);
      const input = policyInput({ operationId: value.data.operationId, expectedRevision: value.data.expectedRevision,
        dailyLimitMicroUsd: parsed.policy.dailyLimitMicroUsd });
      if (parsed.policy.revision !== input.expectedRevision + 1) invalid();
    } else invalid();
  } else if (value.ok === false) {
    exact(value, [...BINDING, "ok", "error"]);
    if (!PRIVATE_MODEL_BUDGET_CHANNEL_ERRORS.includes(value.error as PrivateModelBudgetChannelError)) invalid();
  } else invalid();
  bounded(value); return structuredClone(value) as unknown as PrivateModelBudgetResponse;
}
function responseBinding(request: PrivateModelBudgetRequest): PrivateModelBudgetBinding {
  return { channel: "private_model_budget", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId };
}
export function privateModelBudgetSuccess(request: PrivateModelBudgetRequest, data: PrivateModelBudgetData): PrivateModelBudgetResponse {
  return parsePrivateModelBudgetResponse({ ...responseBinding(request), ok: true, data });
}
export function privateModelBudgetFailure(request: PrivateModelBudgetRequest, error: PrivateModelBudgetChannelError): PrivateModelBudgetResponse {
  return parsePrivateModelBudgetResponse({ ...responseBinding(request), ok: false, error });
}
export function validatePrivateModelBudgetReply(request: PrivateModelBudgetRequest, value: unknown): PrivateModelBudgetResponse {
  const response = parsePrivateModelBudgetResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    if (request.action === "status") { if (response.data.kind !== "status") invalid(); }
    else if (request.action === "price") {
      const stored = response.data.kind === "status" ? response.data.status.modelPrice : undefined;
      if (!stored || stored.model !== request.model || stored.inputMicroUsdPerMillion !== request.inputMicroUsdPerMillion
        || stored.outputMicroUsdPerMillion !== request.outputMicroUsdPerMillion) invalid();
    }
    else if (response.data.kind !== "update" || response.data.operationId !== request.operationId
      || response.data.expectedRevision !== request.expectedRevision
      || response.data.status.policy.dailyLimitMicroUsd !== request.dailyLimitMicroUsd) invalid();
  }
  return response;
}
