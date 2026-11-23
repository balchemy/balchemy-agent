/** Owner-local trading wallet IPC and envelope shapes. Only the encrypted envelope,
 * the public address and an unlock passphrase ever cross this channel; the secret
 * key never does. Status is address + state only. No signing, no trading.
 * A locked address is unauthenticated until a successful unlock in this daemon run:
 * `addressVerified` says so, and no surface may present an unverified address as a
 * funding target. */
import { createHash } from "node:crypto";
import { isId, MAX_FRAME_BYTES } from "./protocol.js";
import { isPrivateModelPassphrase } from "./private-brain-protocol.js";
import { isSolanaAddress } from "./solana-base58.js";

export const TRADING_KEYSTORE_SUITE = "scrypt-n131072-r8-p1-aes256gcm-v1" as const;
export const TRADING_KEYSTORE_SCHEMA_VERSION = 1 as const;
/** scrypt N=2^17 can take seconds on a loaded machine; unlocks are also serialized. */
export const TRADING_WALLET_UNLOCK_TIMEOUT_MS = 20_000;
export interface TradingWalletScope { localProfileId: string; agentId: string }
/** Persisted verbatim. The ciphertext is the AES-256-GCM sealed 32-byte Ed25519 seed. */
export interface TradingWalletEnvelope {
  schemaVersion: 1; localProfileId: string; agentId: string; chain: "solana"; address: string;
  suite: typeof TRADING_KEYSTORE_SUITE; salt: string; nonce: string; ciphertext: string; tag: string;
  /** Passphrase-independent corruption check; authenticity comes from GCM + AAD. */
  checksum: string;
}
/** `addressVerified` is true only after this daemon decrypted the envelope and derived the same address. */
export type TradingWalletStatus = { state: "absent" } | { state: "held" }
  | { state: "locked"; address: string; addressVerified: boolean } | { state: "unlocked"; address: string; addressVerified: true };
/** `state_unavailable` from create is a refusal before any write; `write_outcome_unknown` may follow a durable write. */
export const PRIVATE_TRADING_WALLET_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent",
  "wallet_missing", "wallet_exists", "wallet_locked", "unlock_failed", "pairing_wallet", "duplicate_wallet",
  "busy", "cancelled", "state_unavailable", "write_outcome_unknown", "recovery_refused", "closing",
  // A2a: too many wrong passphrases in a row (the keystore's in-memory throttle); unlock again after the wait.
  "proof_throttled"] as const;
export type PrivateTradingWalletError = typeof PRIVATE_TRADING_WALLET_ERRORS[number];
/** NFC-normalized for this store only, identically at seal and unlock (the model vault keeps
 * raw UTF-8 so existing vault envelopes still open). Both forms must satisfy the shared policy. */
export function normalizeTradingWalletPassphrase(value: string): string { return value.normalize("NFC"); }
export function isTradingWalletPassphrase(value: unknown): value is string {
  return isPrivateModelPassphrase(value) && isPrivateModelPassphrase(normalizeTradingWalletPassphrase(value));
}

export interface PrivateTradingWalletBinding {
  channel: "private_trading_wallet"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
/** `preflight` is read-only: every install precondition, optionally for a known address.
 * `recover` removes only an orphan initialization marker that has no envelope. */
export type PrivateTradingWalletRequest = PrivateTradingWalletBinding & (
  { action: "status" } | { action: "lock" } | { action: "unlock"; passphrase: string }
  | { action: "preflight" } | { action: "preflight"; address: string } | { action: "recover" }
  | { action: "create"; envelope: TradingWalletEnvelope }
);
export type PrivateTradingWalletResponse = PrivateTradingWalletBinding & (
  { ok: true; wallet: TradingWalletStatus } | { ok: false; error: PrivateTradingWalletError }
);

const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const ENVELOPE = ["schemaVersion", "localProfileId", "agentId", "chain", "address", "suite", "salt", "nonce", "ciphertext", "tag", "checksum"];
export class PrivateTradingWalletProtocolError extends Error {
  constructor() { super("Invalid local trading wallet message"); this.name = "PrivateTradingWalletProtocolError"; }
}
function invalid(): never { throw new PrivateTradingWalletProtocolError(); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function record(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
}
/** Reads one own data property without invoking accessors. */
function field(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function base64(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || value.length !== Math.ceil(bytes / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length === bytes && decoded.toString("base64") === value;
}
function bounded(value: unknown): void {
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); } catch { invalid(); }
}

export function tradingWalletChecksum(value: Omit<TradingWalletEnvelope, "checksum">): string {
  return createHash("sha256").update(JSON.stringify(["balchemy.trading-wallet.checksum.v1", value.schemaVersion, value.localProfileId,
    value.agentId, value.chain, value.address, value.suite, value.salt, value.nonce, value.ciphertext, value.tag]), "utf8").digest("hex");
}
/** Header fields bound into GCM: a moved, renamed or re-addressed envelope never opens. */
export function tradingWalletAad(value: Omit<TradingWalletEnvelope, "ciphertext" | "tag" | "checksum">): Buffer {
  return Buffer.from(JSON.stringify(["balchemy.trading-wallet.v1", value.schemaVersion, value.localProfileId, value.agentId,
    value.chain, value.address, value.suite, value.salt, value.nonce]), "utf8");
}
/** Closed structural check against the expected owner scope. Never decrypts. */
export function parseTradingWalletEnvelope(value: unknown, scope: TradingWalletScope): TradingWalletEnvelope {
  exact(value, ENVELOPE);
  if (value.schemaVersion !== TRADING_KEYSTORE_SCHEMA_VERSION || !isId(value.localProfileId) || value.localProfileId !== scope.localProfileId
    || !isId(value.agentId) || value.agentId !== scope.agentId || value.chain !== "solana" || !isSolanaAddress(value.address)
    || value.suite !== TRADING_KEYSTORE_SUITE || !base64(value.salt, 32) || !base64(value.nonce, 12)
    || !base64(value.ciphertext, 32) || !base64(value.tag, 16)
    || typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/.test(value.checksum)) invalid();
  const envelope = Object.freeze({ ...value }) as unknown as TradingWalletEnvelope;
  if (tradingWalletChecksum(envelope) !== envelope.checksum) invalid();
  return envelope;
}
export function parseTradingWalletStatus(value: unknown): TradingWalletStatus {
  record(value); const state = field(value, "state");
  if (state === "absent" || state === "held") exact(value, ["state"]);
  else if (state === "locked" || state === "unlocked") {
    exact(value, ["state", "address", "addressVerified"]);
    if (!isSolanaAddress(value.address) || typeof value.addressVerified !== "boolean"
      || (state === "unlocked" && value.addressVerified !== true)) invalid();
  } else invalid();
  return Object.freeze({ ...value }) as unknown as TradingWalletStatus;
}

function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_trading_wallet" || value.version !== 1
    || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
export function parsePrivateTradingWalletRequest(value: unknown): PrivateTradingWalletRequest {
  record(value); const action = field(value, "action");
  if (action === "status" || action === "lock" || action === "recover") exact(value, [...BINDING, "action"]);
  else if (action === "preflight") exact(value, Object.hasOwn(value, "address") ? [...BINDING, "action", "address"] : [...BINDING, "action"]);
  else if (action === "unlock") exact(value, [...BINDING, "action", "passphrase"]);
  else if (action === "create") exact(value, [...BINDING, "action", "envelope"]);
  else invalid();
  binding(value);
  if (action === "unlock" && !isTradingWalletPassphrase(value.passphrase)) invalid();
  if (action === "preflight" && Object.hasOwn(value, "address") && !isSolanaAddress(value.address)) invalid();
  const envelope = action === "create" ? { envelope: parseTradingWalletEnvelope(value.envelope,
    { localProfileId: value.localProfileId as string, agentId: value.agentId as string }) } : {};
  bounded(value);
  return Object.freeze({ ...value, ...envelope }) as unknown as PrivateTradingWalletRequest;
}
export function parsePrivateTradingWalletResponse(value: unknown): PrivateTradingWalletResponse {
  record(value); const ok = field(value, "ok");
  if (ok === true) exact(value, [...BINDING, "ok", "wallet"]);
  else if (ok === false) exact(value, [...BINDING, "ok", "error"]);
  else invalid();
  binding(value);
  if (ok === false && !PRIVATE_TRADING_WALLET_ERRORS.includes(value.error as PrivateTradingWalletError)) invalid();
  const wallet = ok === true ? { wallet: parseTradingWalletStatus(value.wallet) } : {};
  bounded(value);
  return Object.freeze({ ...value, ...wallet }) as unknown as PrivateTradingWalletResponse;
}
function responseBinding(request: PrivateTradingWalletRequest): PrivateTradingWalletBinding {
  return { channel: "private_trading_wallet", version: 1, id: request.id, localProfileId: request.localProfileId,
    instanceId: request.instanceId, agentId: request.agentId };
}
export function privateTradingWalletSuccess(request: PrivateTradingWalletRequest, wallet: TradingWalletStatus): PrivateTradingWalletResponse {
  return parsePrivateTradingWalletResponse({ ...responseBinding(request), ok: true, wallet: { ...wallet } });
}
export function privateTradingWalletFailure(request: PrivateTradingWalletRequest, error: PrivateTradingWalletError): PrivateTradingWalletResponse {
  return parsePrivateTradingWalletResponse({ ...responseBinding(request), ok: false, error });
}
/** A reply must answer this exact request and report the state that action implies. */
export function validatePrivateTradingWalletReply(request: PrivateTradingWalletRequest, value: unknown): PrivateTradingWalletResponse {
  const response = parsePrivateTradingWalletResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    const wallet = response.wallet;
    if ((request.action === "create" && (wallet.state !== "locked" || wallet.address !== request.envelope.address))
      || (request.action === "unlock" && wallet.state !== "unlocked")
      || ((request.action === "preflight" || request.action === "recover") && wallet.state !== "absent")
      || (request.action === "lock" && wallet.state === "unlocked")) invalid();
  }
  return response;
}
