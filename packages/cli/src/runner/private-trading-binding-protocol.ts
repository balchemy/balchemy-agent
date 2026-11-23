/** Owner-local trading-wallet Hub binding IPC. Only public binding facts cross this channel: never a key, nonce,
 * proof, signature or provider body. Binding proves possession of the agent's trading key to Balchemy; it grants no
 * trading, signing or execution authority. */
import { isId, MAX_FRAME_BYTES } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";

/** A bind waits for the SDK's 20 s proof exchange plus local signing. */
export const TRADING_BINDING_TIMEOUT_MS = 25_000;
/** `held`: a local record exists but could not be verified; it is preserved and never treated as unbound. */
export type TradingWalletBindingView = { state: "unbound" } | { state: "held" }
  | { state: "bound"; walletBindingId: string; address: string; boundAt: string }
  | { state: "revoked"; address: string; walletBindingId: string | null; observedAt: string };
/** Refusals before the bind request is sent are definite; `outcome_unknown` may follow an accepted bind (an exact
 * re-bind of the same wallet is idempotent server-side); `write_outcome_unknown` means Balchemy bound it but the local
 * record may not be saved. Conflict codes are reported only after both signatures verified server-side. */
export const PRIVATE_TRADING_BINDING_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent",
  "not_paired", "lease_unavailable", "wallet_missing", "wallet_locked", "wallet_held", "pairing_wallet",
  "identity_wallet", "runner_key", "bound_elsewhere", "already_bound", "revoked", "conflict", "proof_rejected",
  "rate_limited", "server_rejected", "server_unavailable", "outcome_unknown", "write_outcome_unknown", "busy",
  "state_unavailable", "closing"] as const;
export type PrivateTradingBindingError = typeof PRIVATE_TRADING_BINDING_ERRORS[number];
export interface PrivateTradingBindingFrame {
  channel: "private_trading_binding"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateTradingBindingRequest = PrivateTradingBindingFrame & { action: "status" | "bind" };
export type PrivateTradingBindingResponse = PrivateTradingBindingFrame & (
  { ok: true; binding: TradingWalletBindingView } | { ok: false; error: PrivateTradingBindingError }
);

const FRAME = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class PrivateTradingBindingProtocolError extends Error {
  constructor() { super("Invalid local trading wallet binding message"); this.name = "PrivateTradingBindingProtocolError"; }
}
function invalid(): never { throw new PrivateTradingBindingProtocolError(); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") invalid();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function iso(value: unknown): value is string {
  return typeof value === "string" && value.length === 24 && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function frame(value: Record<string, unknown>): void {
  if (value.channel !== "private_trading_binding" || value.version !== 1
    || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); } catch { invalid(); }
}

export function parseTradingWalletBindingView(value: unknown): TradingWalletBindingView {
  const state = field(value, "state");
  if (state === "unbound" || state === "held") exact(value, ["state"]);
  else if (state === "bound") {
    exact(value, ["state", "walletBindingId", "address", "boundAt"]);
    if (typeof value.walletBindingId !== "string" || !UUID.test(value.walletBindingId) || !isSolanaAddress(value.address) || !iso(value.boundAt)) invalid();
  } else if (state === "revoked") {
    exact(value, ["state", "address", "walletBindingId", "observedAt"]);
    if (!isSolanaAddress(value.address) || !iso(value.observedAt)
      || (value.walletBindingId !== null && (typeof value.walletBindingId !== "string" || !UUID.test(value.walletBindingId)))) invalid();
  } else invalid();
  return Object.freeze({ ...(value as Record<string, unknown>) }) as unknown as TradingWalletBindingView;
}
export function parsePrivateTradingBindingRequest(value: unknown): PrivateTradingBindingRequest {
  exact(value, [...FRAME, "action"]); frame(value);
  if (value.action !== "status" && value.action !== "bind") invalid();
  return Object.freeze({ ...value }) as unknown as PrivateTradingBindingRequest;
}
export function parsePrivateTradingBindingResponse(value: unknown): PrivateTradingBindingResponse {
  const ok = field(value, "ok");
  if (ok === true) exact(value, [...FRAME, "ok", "binding"]);
  else if (ok === false) exact(value, [...FRAME, "ok", "error"]);
  else invalid();
  frame(value);
  if (ok === false && !PRIVATE_TRADING_BINDING_ERRORS.includes(value.error as PrivateTradingBindingError)) invalid();
  const binding = ok === true ? { binding: parseTradingWalletBindingView(value.binding) } : {};
  return Object.freeze({ ...value, ...binding }) as unknown as PrivateTradingBindingResponse;
}
function responseFrame(request: PrivateTradingBindingRequest): PrivateTradingBindingFrame {
  return { channel: "private_trading_binding", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId };
}
export function privateTradingBindingSuccess(request: PrivateTradingBindingRequest, binding: TradingWalletBindingView): PrivateTradingBindingResponse {
  return parsePrivateTradingBindingResponse({ ...responseFrame(request), ok: true, binding: { ...binding } });
}
export function privateTradingBindingFailure(request: PrivateTradingBindingRequest, error: PrivateTradingBindingError): PrivateTradingBindingResponse {
  return parsePrivateTradingBindingResponse({ ...responseFrame(request), ok: false, error });
}
/** A reply must answer this exact request; a successful bind always reports an active binding. */
export function validatePrivateTradingBindingReply(request: PrivateTradingBindingRequest, value: unknown): PrivateTradingBindingResponse {
  const response = parsePrivateTradingBindingResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId
    || (response.ok && request.action === "bind" && response.binding.state !== "bound")) invalid();
  return response;
}
