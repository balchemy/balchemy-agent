/** K2 one-visit setup IPC (channel `private_setup`, owner socket only). Read-only public facts of the two daemon setup workers: the
 * automatic trading-wallet link after pairing (private-auto-bind.ts) and the spend-ceiling approval (private-first-enable-ceiling.ts).
 * `watch` is the cockpit's keep-alive while its setup step is open: it only keeps the ceiling worker polling the owner's proposal; it
 * opens, approves, binds or arms nothing. Never a key, nonce, proof, signature, URL or provider body. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, isId, MAX_FRAME_BYTES } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { PRIVATE_TRADING_BINDING_ERRORS, type PrivateTradingBindingError } from "./private-trading-binding-protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";

/** The automatic link: `off` when this daemon runs no setup workers (an in-process test daemon). */
export type PrivateSetupLinkView = { state: "off" | "unpaired" | "no_wallet" | "locked" | "waiting_lease" | "linking" | "unavailable" }
  | { state: "retrying"; reason: PrivateTradingBindingError }
  | { state: "linked"; address: string; walletBindingId: string }
  | { state: "refused"; reason: PrivateTradingBindingError };
/** Final for this setup run (the cockpit skips the step; arming's own approval flow stays the fallback). `too_many_open` and
 * `request_failed` end only the current proposal: a new proposal from the page (a new id) is served again. */
export const PRIVATE_CEILING_REFUSALS = ["stale", "unverifiable", "unsupported", "mismatch", "timed_out", "too_many_open", "request_failed",
  "state_unavailable"] as const;
export type PrivateCeilingRefusal = typeof PRIVATE_CEILING_REFUSALS[number];
export const PRIVATE_CEILING_RETRY_REASONS = ["network", "rate_limited", "lease"] as const;
export type PrivateCeilingRetryReason = typeof PRIVATE_CEILING_RETRY_REASONS[number];
/** Lamports as canonical decimal strings; `null` in `approved` is a signed `none` (an approval from the arming flow). */
export type PrivateSetupCeilingView = { state: "idle" | "not_ready" | "waiting" }
  | { state: "retrying"; reason: PrivateCeilingRetryReason }
  | { state: "requesting" | "expired"; perTradeLamports: string; dailyLamports: string }
  | { state: "challenge"; challengeId: string; checkCode: string; expiresAt: string; perTradeLamports: string; dailyLamports: string }
  | { state: "approved"; perTradeLamports: string | null; dailyLamports: string | null }
  | { state: "refused"; reason: PrivateCeilingRefusal };
export interface PrivateSetupView { link: PrivateSetupLinkView; ceiling: PrivateSetupCeilingView }

export const PRIVATE_SETUP_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent", "setup_unavailable",
  "state_unavailable", "closing"] as const;
export type PrivateSetupError = typeof PRIVATE_SETUP_ERRORS[number];
export interface PrivateSetupFrame { channel: "private_setup"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string }
export type PrivateSetupRequest = PrivateSetupFrame & { action: "status" | "watch" };
export type PrivateSetupResponse = PrivateSetupFrame & ({ ok: true; setup: PrivateSetupView } | { ok: false; error: PrivateSetupError });

const FRAME = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LAMPORTS = /^[1-9][0-9]{0,19}$/;
const CHECK_CODE = /^[A-Za-z0-9-]{4,32}$/;
const STATUS_TIMEOUT_MS = 3_000;
export class PrivateSetupProtocolError extends Error {
  constructor() { super("Invalid local setup message"); this.name = "PrivateSetupProtocolError"; }
}
function invalid(): never { throw new PrivateSetupProtocolError(); }
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
const lamports = (value: unknown): value is string => typeof value === "string" && LAMPORTS.test(value);
const bindingError = (value: unknown): value is PrivateTradingBindingError => PRIVATE_TRADING_BINDING_ERRORS.includes(value as PrivateTradingBindingError);
function frame(value: Record<string, unknown>): void {
  if (value.channel !== "private_setup" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); } catch { invalid(); }
}

export function parsePrivateSetupLinkView(value: unknown): PrivateSetupLinkView {
  const state = field(value, "state");
  if (["off", "unpaired", "no_wallet", "locked", "waiting_lease", "linking", "unavailable"].includes(state as string)) exact(value, ["state"]);
  else if (state === "retrying" || state === "refused") { exact(value, ["state", "reason"]); if (!bindingError(value.reason)) invalid(); }
  else if (state === "linked") {
    exact(value, ["state", "address", "walletBindingId"]);
    if (!isSolanaAddress(value.address) || typeof value.walletBindingId !== "string" || !UUID.test(value.walletBindingId)) invalid();
  } else invalid();
  return Object.freeze({ ...(value as Record<string, unknown>) }) as unknown as PrivateSetupLinkView;
}
export function parsePrivateSetupCeilingView(value: unknown): PrivateSetupCeilingView {
  const state = field(value, "state");
  if (state === "idle" || state === "not_ready" || state === "waiting") exact(value, ["state"]);
  else if (state === "retrying") { exact(value, ["state", "reason"]); if (!PRIVATE_CEILING_RETRY_REASONS.includes(value.reason as PrivateCeilingRetryReason)) invalid(); }
  else if (state === "refused") { exact(value, ["state", "reason"]); if (!PRIVATE_CEILING_REFUSALS.includes(value.reason as PrivateCeilingRefusal)) invalid(); }
  else if (state === "requesting" || state === "expired") {
    exact(value, ["state", "perTradeLamports", "dailyLamports"]);
    if (!lamports(value.perTradeLamports) || !lamports(value.dailyLamports) || BigInt(value.perTradeLamports) > BigInt(value.dailyLamports)) invalid();
  } else if (state === "challenge") {
    exact(value, ["state", "challengeId", "checkCode", "expiresAt", "perTradeLamports", "dailyLamports"]);
    if (typeof value.challengeId !== "string" || !UUID.test(value.challengeId) || typeof value.checkCode !== "string" || !CHECK_CODE.test(value.checkCode)
      || !iso(value.expiresAt) || !lamports(value.perTradeLamports) || !lamports(value.dailyLamports)
      || BigInt(value.perTradeLamports) > BigInt(value.dailyLamports)) invalid();
  } else if (state === "approved") {
    exact(value, ["state", "perTradeLamports", "dailyLamports"]);
    if ((value.perTradeLamports !== null && !lamports(value.perTradeLamports)) || (value.dailyLamports !== null && !lamports(value.dailyLamports))) invalid();
  } else invalid();
  return Object.freeze({ ...(value as Record<string, unknown>) }) as unknown as PrivateSetupCeilingView;
}
export function parsePrivateSetupRequest(value: unknown): PrivateSetupRequest {
  exact(value, [...FRAME, "action"]); frame(value);
  if (value.action !== "status" && value.action !== "watch") invalid();
  return Object.freeze({ ...value }) as unknown as PrivateSetupRequest;
}
export function parsePrivateSetupResponse(value: unknown): PrivateSetupResponse {
  const ok = field(value, "ok");
  if (ok === true) exact(value, [...FRAME, "ok", "setup"]);
  else if (ok === false) exact(value, [...FRAME, "ok", "error"]);
  else invalid();
  frame(value);
  if (ok === false) {
    if (!PRIVATE_SETUP_ERRORS.includes(value.error as PrivateSetupError)) invalid();
    return Object.freeze({ ...value }) as unknown as PrivateSetupResponse;
  }
  exact(value.setup, ["link", "ceiling"]);
  const setup = Object.freeze({ link: parsePrivateSetupLinkView(value.setup.link), ceiling: parsePrivateSetupCeilingView(value.setup.ceiling) });
  return Object.freeze({ ...value, setup }) as unknown as PrivateSetupResponse;
}
function responseFrame(request: PrivateSetupRequest): PrivateSetupFrame {
  return { channel: "private_setup", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateSetupSuccess(request: PrivateSetupRequest, setup: PrivateSetupView): PrivateSetupResponse {
  return parsePrivateSetupResponse({ ...responseFrame(request), ok: true, setup: { link: { ...setup.link }, ceiling: { ...setup.ceiling } } });
}
export function privateSetupFailure(request: PrivateSetupRequest, error: PrivateSetupError): PrivateSetupResponse {
  return parsePrivateSetupResponse({ ...responseFrame(request), ok: false, error });
}
/** A reply must answer this exact request. */
export function validatePrivateSetupReply(request: PrivateSetupRequest, value: unknown): PrivateSetupResponse {
  const response = parsePrivateSetupResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
    || response.agentId !== request.agentId) invalid();
  return response;
}
export function privateSetupRequest(target: PrivateBrainTarget, action: "status" | "watch"): PrivateSetupRequest {
  return parsePrivateSetupRequest({ channel: "private_setup", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId, action });
}

export type PrivateSetupTransport = (socketPath: string, request: PrivateSetupRequest) => Promise<PrivateSetupResponse>;
/** One bounded owner-socket exchange (read-only; a lost reply changes nothing and may be asked again). */
export async function requestPrivateSetup(socketPath: string, input: PrivateSetupRequest): Promise<PrivateSetupResponse> {
  const request = parsePrivateSetupRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateSetupProtocolError(); }
  return new Promise<PrivateSetupResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let settled = false;
    const fail = (): void => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); reject(new PrivateSetupProtocolError()); };
    const deadline = setTimeout(fail, STATUS_TIMEOUT_MS);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try { const response = validatePrivateSetupReply(request, reader.finish()); settled = true; clearTimeout(deadline); socket.destroy(); resolve(response); }
      catch { fail(); }
    });
  });
}
