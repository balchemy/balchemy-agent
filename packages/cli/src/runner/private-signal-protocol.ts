/** Owner-local readback only. This channel cannot enqueue, retry or execute work. */
import { isId, isTimestamp, MAX_FRAME_BYTES } from "./protocol.js";
import { assetRef } from "./private-research-evidence.js";
import { parsePrivateSignalJob, PRIVATE_SIGNAL_HOLD_REASONS, type PrivateSignalJob, type PrivateSignalJobState,
  type PrivateSignalHoldReason, type PrivateSignalFailure } from "./private-signal-job.js";
import type { PrivateOuterAction } from "./private-outer-decision.js";
import { parsePrivateExecutionOutcomeView, type PrivateExecutionOutcomeView } from "./private-execution-intents.js";

export const PRIVATE_SIGNAL_PAGE_SIZE = 10;
export interface PrivateSignalSummary {
  ordinal: number; jobId: string; agentId: string; state: PrivateSignalJobState;
  createdAt: number; updatedAt: number; platform: "telegram" | "discord" | "launchpad"; sourceId: string;
  chain: "solana"; assetId: string; refId: string; execution: "not_executed";
  action?: PrivateOuterAction; reason?: PrivateSignalHoldReason | PrivateSignalFailure;
  /** S8b: the recorded execution outcome of a completed buy decision (absent when none was recorded). */
  executionOutcome?: PrivateExecutionOutcomeView;
}
export interface PrivateSignalPage { items: PrivateSignalSummary[]; nextBeforeOrdinal: number | null }
export interface PrivateSignalBinding {
  channel: "private_signals"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateSignalRequest = PrivateSignalBinding & (
  { action: "list"; beforeOrdinal?: number } | { action: "read"; jobId: string }
);
export const PRIVATE_SIGNAL_READ_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent",
  "job_not_found", "state_unavailable", "closing", "busy", "cancelled", "revision_conflict"] as const;
export type PrivateSignalReadError = typeof PRIVATE_SIGNAL_READ_ERRORS[number];
export type PrivateSignalData = { kind: "list"; page: PrivateSignalPage } | { kind: "read"; job: PrivateSignalJob; executionOutcome?: PrivateExecutionOutcomeView };
export type PrivateSignalResponse = PrivateSignalBinding & ({ ok: true; data: PrivateSignalData } | { ok: false; error: PrivateSignalReadError });
const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
function invalid(): never { throw new Error("Invalid private signal readback"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_signals" || value.version !== 1
    || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
function summary(value: unknown, agentId: string): PrivateSignalSummary {
  exact(value, ["ordinal", "jobId", "agentId", "state", "createdAt", "updatedAt", "platform", "sourceId", "chain", "assetId", "refId", "execution"], ["action", "reason", "executionOutcome"]);
  if (!positive(value.ordinal) || typeof value.jobId !== "string" || !/^signal_[0-9a-f]{64}$/.test(value.jobId)
    || value.agentId !== agentId || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt) || value.updatedAt < value.createdAt
    || typeof value.state !== "string" || !["received", "running", "completed", "held", "failed", "cancelled", "interrupted"].includes(value.state)
    || (value.platform !== "telegram" && value.platform !== "discord" && value.platform !== "launchpad") || typeof value.sourceId !== "string" || !/^src_[0-9a-f]{24}$/.test(value.sourceId)
    || value.chain !== "solana" || typeof value.assetId !== "string" || value.refId !== assetRef("solana", value.assetId).refId
    || value.execution !== "not_executed") invalid();
  if (value.state === "completed") {
    if (typeof value.action !== "string" || !["buy", "sell", "hold", "skip"].includes(value.action)) invalid();
  } else if (Object.hasOwn(value, "action")) invalid();
  if (value.state === "held") { if (!PRIVATE_SIGNAL_HOLD_REASONS.includes(value.reason as PrivateSignalHoldReason)) invalid(); }
  else if (value.state === "failed") { if (typeof value.reason !== "string" || !["provider_unavailable", "research_unavailable", "invalid_result"].includes(value.reason)) invalid(); }
  else if (Object.hasOwn(value, "reason")) invalid();
  // An execution outcome exists only for a completed buy decision.
  if (Object.hasOwn(value, "executionOutcome")) { if (value.action !== "buy") invalid(); parsePrivateExecutionOutcomeView(value.executionOutcome); }
  return structuredClone(value) as unknown as PrivateSignalSummary;
}
export function summarizePrivateSignalJob(job: PrivateSignalJob, ordinal: number): PrivateSignalSummary {
  const checked = parsePrivateSignalJob(job); const signal = checked.receipt.signal;
  return summary({ ordinal, jobId: checked.jobId, agentId: checked.agentId, state: checked.state,
    createdAt: checked.createdAt, updatedAt: checked.updatedAt, platform: signal.platform, sourceId: signal.sourceId,
    chain: signal.chain, assetId: signal.assetId, refId: `asset:${signal.chain}:${signal.assetId}`, execution: "not_executed",
    ...(checked.result ? { action: checked.result.decision.action } : {}),
    ...(checked.reason ? { reason: checked.reason } : {}), ...(checked.error ? { reason: checked.error } : {}) }, checked.agentId);
}
export function parsePrivateSignalPage(value: unknown, agentId: string): PrivateSignalPage {
  if (!isId(agentId)) invalid(); exact(value, ["items", "nextBeforeOrdinal"]);
  if (!Array.isArray(value.items) || Object.getPrototypeOf(value.items) !== Array.prototype || value.items.length > PRIVATE_SIGNAL_PAGE_SIZE
    || Reflect.ownKeys(value.items).length !== value.items.length + 1 || Object.keys(value.items).length !== value.items.length
    || Object.values(Object.getOwnPropertyDescriptors(value.items)).some((field) => !("value" in field))) invalid();
  const items = value.items.map((item: unknown) => summary(item, agentId));
  if (new Set(items.map((item) => item.jobId)).size !== items.length
    || items.some((item, index) => index > 0 && item.ordinal >= items[index - 1]!.ordinal)
    || (value.nextBeforeOrdinal !== null && (!positive(value.nextBeforeOrdinal) || items.length !== PRIVATE_SIGNAL_PAGE_SIZE
      || value.nextBeforeOrdinal !== items.at(-1)!.ordinal))) invalid();
  return { items, nextBeforeOrdinal: value.nextBeforeOrdinal as number | null };
}
export function parsePrivateSignalRequest(value: unknown): PrivateSignalRequest {
  exact(value, [...BINDING, "action"], ["beforeOrdinal", "jobId"]); binding(value);
  if (value.action === "list") {
    if (Object.hasOwn(value, "jobId") || (Object.hasOwn(value, "beforeOrdinal") && !positive(value.beforeOrdinal))) invalid();
  } else if (value.action !== "read" || Object.hasOwn(value, "beforeOrdinal") || typeof value.jobId !== "string" || !/^signal_[0-9a-f]{64}$/.test(value.jobId)) invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateSignalRequest;
}
export function parsePrivateSignalResponse(value: unknown): PrivateSignalResponse {
  exact(value, [...BINDING, "ok"], ["data", "error"]); binding(value);
  if (value.ok === true) {
    if (Object.hasOwn(value, "error")) invalid(); exact(value.data, ["kind"], ["page", "job", "executionOutcome"]);
    if (value.data.kind === "list") {
      exact(value.data, ["kind", "page"]); parsePrivateSignalPage(value.data.page, value.agentId as string);
    } else if (value.data.kind === "read") {
      exact(value.data, ["kind", "job"], ["executionOutcome"]); const job = parsePrivateSignalJob(value.data.job);
      if (job.agentId !== value.agentId || job.receipt.localProfileId !== value.localProfileId) invalid();
      if (Object.hasOwn(value.data, "executionOutcome")) {
        if (job.state !== "completed" || job.result?.decision.action !== "buy") invalid();
        parsePrivateExecutionOutcomeView(value.data.executionOutcome);
      }
    } else invalid();
  } else if (value.ok !== false || Object.hasOwn(value, "data") || !PRIVATE_SIGNAL_READ_ERRORS.includes(value.error as PrivateSignalReadError)) invalid();
  bounded(value); return structuredClone(value) as unknown as PrivateSignalResponse;
}
function responseBinding(request: PrivateSignalRequest): PrivateSignalBinding {
  return { channel: "private_signals", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateSignalSuccess(request: PrivateSignalRequest, data: PrivateSignalData): PrivateSignalResponse {
  return parsePrivateSignalResponse({ ...responseBinding(request), ok: true, data });
}
export function privateSignalFailure(request: PrivateSignalRequest, error: PrivateSignalReadError): PrivateSignalResponse {
  return parsePrivateSignalResponse({ ...responseBinding(request), ok: false, error });
}

/** Pin the transport result to the exact read, not merely the daemon envelope. */
export function validatePrivateSignalReply(request: PrivateSignalRequest, value: unknown): PrivateSignalResponse {
  const response = parsePrivateSignalResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    if (request.action === "read") {
      if (response.data.kind !== "read" || response.data.job.jobId !== request.jobId) invalid();
    } else if (response.data.kind !== "list" || (request.beforeOrdinal !== undefined
      && response.data.page.items.some((item) => item.ordinal >= request.beforeOrdinal!))) invalid();
  }
  return response;
}
