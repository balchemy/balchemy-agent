/** Owner-local previews. This channel has no confirmation, signing or submission operation. */
import { exactKeys, isId, isRecord, MAX_FRAME_BYTES } from "./protocol.js";
import { parsePrivateSolanaPreviewRequest, parsePrivateSolanaIntentPreview,
  type PrivateSolanaPreviewRequest, type PrivateSolanaIntentPreview } from "./private-solana-intent-preview.js";

export interface PrivateIntentBinding {
  channel: "private_intents"; version: 1; id: string;
  localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateIntentRequest = PrivateIntentBinding & (
  { action: "preview"; request: PrivateSolanaPreviewRequest } | { action: "read"; intentId: string }
);
export const PRIVATE_INTENT_ERRORS = ["invalid_request", "invalid_context", "runtime_conflict", "revision_conflict", "scope_conflict",
  "profile_conflict", "instance_conflict", "unknown_agent", "intent_conflict", "journal_full", "state_unavailable", "closing", "busy"] as const;
export type PrivateIntentErrorCode = typeof PRIVATE_INTENT_ERRORS[number];
export type PrivateIntentResponse = PrivateIntentBinding & (
  { ok: true; preview: PrivateSolanaIntentPreview | null } | { ok: false; error: PrivateIntentErrorCode }
);
const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
function invalid(): never { throw new Error("Invalid private intent message"); }
function binding(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value) || value.channel !== "private_intents" || value.version !== 1
    || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid();
}
export function parsePrivateIntentRequest(value: unknown): PrivateIntentRequest {
  binding(value);
  if (value.action === "preview") {
    if (!exactKeys(value, [...BINDING, "action", "request"])) invalid();
    parsePrivateSolanaPreviewRequest(value.request);
  } else if (value.action !== "read" || !exactKeys(value, [...BINDING, "action", "intentId"]) || !isId(value.intentId)) invalid();
  return structuredClone(value) as unknown as PrivateIntentRequest;
}
export function parsePrivateIntentResponse(value: unknown): PrivateIntentResponse {
  binding(value);
  if (value.ok === true) {
    if (!exactKeys(value, [...BINDING, "ok", "preview"])) invalid();
    if (value.preview !== null) {
      const preview = parsePrivateSolanaIntentPreview(value.preview);
      if (preview.scope.localProfileId !== value.localProfileId || preview.scope.agentId !== value.agentId) invalid();
    }
  } else if (value.ok !== false || !exactKeys(value, [...BINDING, "ok", "error"])
    || !PRIVATE_INTENT_ERRORS.includes(value.error as PrivateIntentErrorCode)) invalid();
  return structuredClone(value) as unknown as PrivateIntentResponse;
}
function responseBinding(request: PrivateIntentRequest): PrivateIntentBinding {
  return { channel: "private_intents", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId };
}
export function privateIntentSuccess(request: PrivateIntentRequest, preview: PrivateSolanaIntentPreview | null): PrivateIntentResponse {
  return parsePrivateIntentResponse({ ...responseBinding(request), ok: true, preview });
}
export function privateIntentFailure(request: PrivateIntentRequest, error: PrivateIntentErrorCode): PrivateIntentResponse {
  return parsePrivateIntentResponse({ ...responseBinding(request), ok: false, error });
}
