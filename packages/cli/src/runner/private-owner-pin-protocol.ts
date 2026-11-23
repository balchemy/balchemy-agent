/** A2a owner-local IPC of the seal step (channel `private_owner_pin`, the owner's 0600 socket only; Hub, the SDK and the backend never
 * reach it). `status` reads what the seal card shows: every field the pin seals from the plaintext pairing record (owner wallet,
 * binding digest, Hub origin, Hub agent id, network id and the runner key fingerprint, in full, to be compared with Hub), the current
 * pin with the same fields, and the authority values with their digest. `seal` echoes what the card showed (every pairing field, the
 * last six characters the owner typed, the authority digest) plus the trading-wallet passphrase as the socket proof (optional in the
 * frame: absent answers `proof_required`); the daemon re-reads everything and refuses any difference. The passphrase is never stored
 * or echoed. Replies carry public facts only. Strict closed shapes both ways. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, isId, isTimestamp, MAX_FRAME_BYTES } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { parsePrivateAuthorityView, type PrivateAuthoritySealState, type PrivateAuthorityView } from "./private-authority-seal.js";
import { PRIVATE_AUTHORITY_ERRORS, PRIVATE_AUTHORITY_FIELDS, PRIVATE_SOCKET_PROOF_ERRORS, SOCKET_PROOF_CLIENT_TIMEOUT_MS,
  type PrivateAuthorityField } from "./private-socket-proof.js";

export interface PrivateOwnerPinBinding {
  channel: "private_owner_pin"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateOwnerPinRequest = PrivateOwnerPinBinding & ({ action: "status" }
  | { action: "seal"; ownerAddress: string; bindingDigest: string; frontendOrigin: string; serverAgentId: string; chainId: string;
    runnerFingerprint: string; suffix: string; authorityDigest: string; passphrase?: string });
export type PrivateOwnerWallet = { chain: "solana" | "base"; address: string };
/** Every field a pin seals from the pairing record (private-owner-pin.ts sameIdentity), as the card shows it: the runner key as its
 * fingerprint (runner-key-fingerprint.ts, what Hub's pairing page showed). */
export interface PrivateOwnerPairingView {
  owner: PrivateOwnerWallet; bindingDigest: string; frontendOrigin: string; serverAgentId: string; chainId: string; runnerFingerprint: string;
}
export const PRIVATE_OWNER_PAIRING_FIELDS = ["owner", "bindingDigest", "frontendOrigin", "serverAgentId", "chainId", "runnerFingerprint"] as const;
export type PrivateOwnerPairingField = typeof PRIVATE_OWNER_PAIRING_FIELDS[number];
/** The pinned fields that differ between two views (owner compared by chain and address). Empty: the same pairing. */
export function privateOwnerPairingDiff(before: PrivateOwnerPairingView, now: PrivateOwnerPairingView): PrivateOwnerPairingField[] {
  return PRIVATE_OWNER_PAIRING_FIELDS.filter((key) => key === "owner"
    ? before.owner.chain !== now.owner.chain || before.owner.address !== now.owner.address : before[key] !== now[key]);
}
/** A Hub origin exactly as the pairing record holds it (scheme, host and port only). */
export function isPrivateOwnerOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try { return new URL(value).origin === value; } catch { return false; }
}
const CHAIN_ID = /^[A-Za-z0-9:._-]{1,128}$/;
export function isPrivateOwnerChainId(value: unknown): value is string { return typeof value === "string" && CHAIN_ID.test(value); }
/** `unpaired`: no adopted pairing; `unpinned`: paired, no pin; `pinned_locked`: a pin exists but the wallet is locked, so it is
 * unverified; `pinned`: verified and equal to the pairing record; `invalid`: the pin does not verify (edited, foreign, unreadable);
 * `mismatch`: verified, but the pairing record or the trading wallet now differs; `held`: the wallet or pairing record is unavailable. */
export const PRIVATE_OWNER_PIN_STATES = ["unpaired", "unpinned", "pinned_locked", "pinned", "invalid", "mismatch", "held"] as const;
export type PrivateOwnerPinState = typeof PRIVATE_OWNER_PIN_STATES[number];
export interface PrivateOwnerPinView {
  state: PrivateOwnerPinState;
  /** The plaintext pairing record (what a seal pins), shown whole: the owner compares the whole address and the Hub origin. */
  pairing: PrivateOwnerPairingView | null;
  /** The stored pin (unverified unless `state` is pinned or mismatch). Replacing it shows old and new of every differing field. */
  pinned: (PrivateOwnerPairingView & { pinnedAt: number }) | null;
}
export const PRIVATE_AUTHORITY_SEAL_STATES = ["unsealed", "sealed_locked", "sealed", "looser", "invalid", "held"] as const;
export interface PrivateAuthoritySealView {
  state: PrivateAuthoritySealState; current: PrivateAuthorityView; currentDigest: string; looser: PrivateAuthorityField[]; sealedAt: number | null;
}
export type PrivateOwnerPinData = { kind: "status" | "sealed"; pin: PrivateOwnerPinView; authority: PrivateAuthoritySealView };
export const PRIVATE_OWNER_PIN_CHANNEL_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent", "closing",
  "state_unavailable", "write_outcome_unknown", "not_paired", "wallet_missing", "shown_mismatch", "suffix_mismatch",
  ...PRIVATE_SOCKET_PROOF_ERRORS, ...PRIVATE_AUTHORITY_ERRORS] as const;
export type PrivateOwnerPinChannelError = typeof PRIVATE_OWNER_PIN_CHANNEL_ERRORS[number];
export type PrivateOwnerPinResponse = PrivateOwnerPinBinding & ({ ok: true; data: PrivateOwnerPinData } | { ok: false; error: PrivateOwnerPinChannelError });

const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const HEX = /^[0-9a-f]{64}$/;
const SHORT_TIMEOUT_MS = 3_000;
function invalid(): never { throw new Error("Invalid private owner pin request or response"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_owner_pin" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); } catch { invalid(); } }
/** A Solana address (base58, 32 bytes) or a Base address (0x + 40 hex). Never only one format: the owner may pair either chain. */
export function isPrivateOwnerAddress(value: unknown): value is string {
  return isSolanaAddress(value) || (typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value));
}
/** The last six characters the owner types; a Base address compares without case (its checksum casing is display only). */
export function privateOwnerSuffixMatches(address: string, suffix: string): boolean {
  if (typeof address !== "string" || typeof suffix !== "string" || suffix.length !== 6 || address.length < 6) return false;
  const tail = address.slice(-6);
  return address.startsWith("0x") ? tail.toLowerCase() === suffix.toLowerCase() : tail === suffix;
}
function wallet(value: unknown): PrivateOwnerWallet {
  exact(value, ["chain", "address"]);
  if ((value.chain !== "solana" && value.chain !== "base") || !isPrivateOwnerAddress(value.address)
    || (value.chain === "solana") !== isSolanaAddress(value.address)) invalid();
  return { chain: value.chain as "solana" | "base", address: value.address as string };
}

const SEAL_PAIRING = ["ownerAddress", "bindingDigest", "frontendOrigin", "serverAgentId", "chainId", "runnerFingerprint"] as const;
export function parsePrivateOwnerPinRequest(value: unknown): PrivateOwnerPinRequest {
  exact(value, [...BINDING, "action"], [...SEAL_PAIRING, "suffix", "authorityDigest", "passphrase"]); binding(value);
  if (value.action === "status") exact(value, [...BINDING, "action"]);
  else if (value.action === "seal") {
    exact(value, [...BINDING, "action", ...SEAL_PAIRING, "suffix", "authorityDigest"], ["passphrase"]);
    if (!isPrivateOwnerAddress(value.ownerAddress) || typeof value.bindingDigest !== "string" || !HEX.test(value.bindingDigest)
      || !isPrivateOwnerOrigin(value.frontendOrigin) || !isId(value.serverAgentId) || !isPrivateOwnerChainId(value.chainId)
      || typeof value.runnerFingerprint !== "string" || !HEX.test(value.runnerFingerprint)
      || typeof value.suffix !== "string" || !/^[0-9A-Za-z]{6}$/.test(value.suffix) || typeof value.authorityDigest !== "string"
      || !HEX.test(value.authorityDigest) || (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase))) invalid();
  } else invalid();
  bounded(value);
  return Object.freeze({ ...value }) as unknown as PrivateOwnerPinRequest;
}
function pairingView(value: Record<string, unknown>): PrivateOwnerPairingView {
  if (typeof value.bindingDigest !== "string" || !HEX.test(value.bindingDigest) || !isPrivateOwnerOrigin(value.frontendOrigin) || !isId(value.serverAgentId)
    || !isPrivateOwnerChainId(value.chainId) || typeof value.runnerFingerprint !== "string" || !HEX.test(value.runnerFingerprint)) invalid();
  return { owner: wallet(value.owner), bindingDigest: value.bindingDigest, frontendOrigin: value.frontendOrigin, serverAgentId: value.serverAgentId as string,
    chainId: value.chainId, runnerFingerprint: value.runnerFingerprint };
}
function pinView(value: unknown): PrivateOwnerPinView {
  exact(value, ["state", "pairing", "pinned"]);
  if (!PRIVATE_OWNER_PIN_STATES.includes(value.state as PrivateOwnerPinState)) invalid();
  let pairing: PrivateOwnerPinView["pairing"] = null;
  const rawPairing = value.pairing;
  if (rawPairing !== null) {
    exact(rawPairing, PRIVATE_OWNER_PAIRING_FIELDS);
    pairing = pairingView(rawPairing);
  }
  let pinned: PrivateOwnerPinView["pinned"] = null;
  const rawPinned = value.pinned;
  if (rawPinned !== null) {
    exact(rawPinned, [...PRIVATE_OWNER_PAIRING_FIELDS, "pinnedAt"]);
    if (!isTimestamp(rawPinned.pinnedAt)) invalid();
    pinned = { ...pairingView(rawPinned), pinnedAt: rawPinned.pinnedAt as number };
  }
  const state = value.state as PrivateOwnerPinState;
  // Unpaired: neither record; unpinned: a pairing record and no pin; pinned: both; pinned_locked and mismatch: a pin.
  if ((state === "unpaired" && (pairing !== null || pinned !== null)) || (state === "unpinned" && (pairing === null || pinned !== null))
    || (state === "pinned" && (pairing === null || pinned === null)) || ((state === "pinned_locked" || state === "mismatch") && pinned === null)) invalid();
  return { state, pairing, pinned };
}
function authorityView(value: unknown): PrivateAuthoritySealView {
  exact(value, ["state", "current", "currentDigest", "looser", "sealedAt"]);
  if (!(PRIVATE_AUTHORITY_SEAL_STATES as readonly unknown[]).includes(value.state) || typeof value.currentDigest !== "string" || !HEX.test(value.currentDigest)
    || !Array.isArray(value.looser) || (value.sealedAt !== null && !isTimestamp(value.sealedAt))) invalid();
  const looser = (value.looser as unknown[]).map((item) => (PRIVATE_AUTHORITY_FIELDS as readonly unknown[]).includes(item) ? item as PrivateAuthorityField : invalid());
  if (new Set(looser).size !== looser.length || (value.state === "looser") !== (looser.length > 0)) invalid();
  let current: PrivateAuthorityView;
  try { current = parsePrivateAuthorityView(value.current); } catch { return invalid(); }
  return { state: value.state as PrivateAuthoritySealState, current, currentDigest: value.currentDigest, looser, sealedAt: value.sealedAt as number | null };
}
export function parsePrivateOwnerPinResponse(value: unknown): PrivateOwnerPinResponse {
  exact(value, [...BINDING, "ok"], ["data", "error"]); binding(value);
  if (value.ok === true) {
    exact(value, [...BINDING, "ok", "data"]);
    const data = value.data;
    exact(data, ["kind", "pin", "authority"]);
    if (data.kind !== "status" && data.kind !== "sealed") invalid();
    const parsed: PrivateOwnerPinData = { kind: data.kind, pin: pinView(data.pin), authority: authorityView(data.authority) };
    // A seal answers only with a verified pin and seal.
    if (parsed.kind === "sealed" && (parsed.pin.state !== "pinned" || parsed.authority.state !== "sealed")) invalid();
    bounded(value);
    return Object.freeze({ channel: "private_owner_pin", version: 1, id: value.id as string, localProfileId: value.localProfileId as string,
      instanceId: value.instanceId as string, agentId: value.agentId as string, ok: true, data: parsed }) as PrivateOwnerPinResponse;
  }
  if (value.ok !== false) invalid();
  exact(value, [...BINDING, "ok", "error"]);
  if (!PRIVATE_OWNER_PIN_CHANNEL_ERRORS.includes(value.error as PrivateOwnerPinChannelError)) invalid();
  bounded(value);
  return Object.freeze({ ...value }) as unknown as PrivateOwnerPinResponse;
}
function responseBinding(request: PrivateOwnerPinRequest): PrivateOwnerPinBinding {
  return { channel: "private_owner_pin", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateOwnerPinSuccess(request: PrivateOwnerPinRequest, data: PrivateOwnerPinData): PrivateOwnerPinResponse {
  return parsePrivateOwnerPinResponse({ ...responseBinding(request), ok: true, data: structuredClone(data) });
}
export function privateOwnerPinFailure(request: PrivateOwnerPinRequest, error: PrivateOwnerPinChannelError): PrivateOwnerPinResponse {
  return parsePrivateOwnerPinResponse({ ...responseBinding(request), ok: false, error });
}
/** The reply must answer exactly this request; a seal reply carries every pairing field that was sent. */
export function validatePrivateOwnerPinReply(request: PrivateOwnerPinRequest, value: unknown): PrivateOwnerPinResponse {
  const response = parsePrivateOwnerPinResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    if ((request.action === "seal") !== (response.data.kind === "sealed")) invalid();
    const pinned = response.data.pin.pinned;
    if (request.action === "seal" && (!pinned || pinned.owner.address !== request.ownerAddress || pinned.bindingDigest !== request.bindingDigest
      || pinned.frontendOrigin !== request.frontendOrigin || pinned.serverAgentId !== request.serverAgentId || pinned.chainId !== request.chainId
      || pinned.runnerFingerprint !== request.runnerFingerprint || response.data.authority.currentDigest !== request.authorityDigest)) invalid();
  }
  return response;
}

export function privateOwnerPinBinding(target: PrivateBrainTarget): PrivateOwnerPinBinding {
  return { channel: "private_owner_pin", version: 1, id: randomUUID(), localProfileId: target.localProfileId, instanceId: target.instanceId, agentId: target.agentId };
}
export class PrivateOwnerPinTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") { super(`Local owner pin ${code}`); this.name = "PrivateOwnerPinTransportError"; }
}
/** One bounded owner-socket exchange. A lost `seal` reply is unknown and never retried. A seal frame with a passphrase waits for the
 * daemon's proof deadline. */
export async function requestPrivateOwnerPin(socketPath: string, input: PrivateOwnerPinRequest): Promise<PrivateOwnerPinResponse> {
  const request = parsePrivateOwnerPinRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateOwnerPinTransportError("connection_unavailable"); }
  return new Promise<PrivateOwnerPinResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
      reject(new PrivateOwnerPinTransportError(sent && request.action === "seal" ? "outcome_unknown" : "connection_unavailable"));
    };
    const deadline = setTimeout(fail, request.action === "seal" && request.passphrase !== undefined ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : SHORT_TIMEOUT_MS);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateOwnerPinReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
