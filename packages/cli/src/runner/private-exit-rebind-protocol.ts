/** Owner-local IPC of the exit re-bind (owner decision of 21 Nov 2026, private-exit-rebind.ts): `preview` (read-only) and `apply` (the
 * owner's typed APPLY <agent>, one durable ledger commit). The owner's 0600 socket only: Hub, the SDK and the backend never reach it.
 * Replies carry public facts only (position ids, public mints, exit percentages in bps, revision ids and digests). Strict closed shapes:
 * unknown keys and out-of-bound values are refused in both directions. A lost `apply` reply is unknown and never resent. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, isId, MAX_FRAME_BYTES } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { isSolanaAddress } from "./solana-base58.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { privateExitSnapshotValid, type PrivateExitSnapshot } from "./private-exit-triggers.js";
import { PRIVATE_EXIT_REBIND_SKIPS, PRIVATE_POSITIONS_MAX_ACTIVE, type PrivateExitRebindSkip } from "./private-positions.js";
import { privateExitRebindDigest, PRIVATE_EXIT_REBIND_ERRORS, type PrivateExitRebindItem, type PrivateExitRebindPreview, type PrivateExitRebindResult,
  type PrivateExitRebindResultItem } from "./private-exit-rebind.js";

export interface PrivateExitRebindBinding {
  channel: "private_exit_rebind"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
export type PrivateExitRebindRequest = PrivateExitRebindBinding & ({ action: "preview" }
  /** A2a: `passphrase` (optional) is the trading-wallet socket proof of a raising change; the daemon decides whether it is required. */
  | { action: "apply"; operationId: string; revisionId: string; rulesDigest: string; previewDigest: string; passphrase?: string });
export type PrivateExitRebindData = { kind: "preview"; preview: PrivateExitRebindPreview } | { kind: "apply"; result: PrivateExitRebindResult };
export const PRIVATE_EXIT_REBIND_CHANNEL_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent", "closing",
  "exits_unavailable", ...PRIVATE_EXIT_REBIND_ERRORS,
  // A2a socket proof (private-socket-proof.ts).
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "busy", "cancelled"] as const;
export type PrivateExitRebindChannelError = typeof PRIVATE_EXIT_REBIND_CHANNEL_ERRORS[number];
export type PrivateExitRebindResponse = PrivateExitRebindBinding & ({ ok: true; data: PrivateExitRebindData } | { ok: false; error: PrivateExitRebindChannelError });

const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const POSITION_ID = /^pos:[0-9a-f]{32}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const REVISION = /^brr_[A-Za-z0-9_-]{1,120}$/;
const TIMEOUT_MS = 10_000;
function invalid(): never { throw new Error("Invalid private exit re-bind request or response"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_exit_rebind" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
function snapshot(value: unknown): PrivateExitSnapshot {
  if (!privateExitSnapshotValid(value)) invalid();
  return structuredClone(value);
}
function skip(value: unknown): PrivateExitRebindSkip {
  return PRIVATE_EXIT_REBIND_SKIPS.find((item) => item === value) ?? invalid();
}

function preview(value: unknown, agentId: string): PrivateExitRebindPreview {
  exact(value, ["revisionId", "rulesDigest", "next", "snapshots", "items", "previewDigest"]);
  const v = value;
  if (typeof v.revisionId !== "string" || !REVISION.test(v.revisionId) || typeof v.rulesDigest !== "string" || !HEX.test(v.rulesDigest)
    || typeof v.previewDigest !== "string" || !HEX.test(v.previewDigest) || !Array.isArray(v.snapshots) || v.snapshots.length > PRIVATE_POSITIONS_MAX_ACTIVE
    || !Array.isArray(v.items) || v.items.length > PRIVATE_POSITIONS_MAX_ACTIVE) invalid();
  const next = snapshot(v.next);
  if (!(next.stopLossBps > 0)) invalid();
  const snapshots = (v.snapshots as unknown[]).map(snapshot);
  const items = (v.items as unknown[]).map((item): PrivateExitRebindItem => {
    exact(item, ["positionId", "tokenMint", "current", "skip"]);
    if (typeof item.positionId !== "string" || !POSITION_ID.test(item.positionId) || !isSolanaAddress(item.tokenMint)
      || typeof item.current !== "number" || !Number.isSafeInteger(item.current) || item.current < 0 || item.current >= snapshots.length) invalid();
    return { positionId: item.positionId as string, tokenMint: item.tokenMint as string, current: item.current as number, skip: item.skip === null ? null : skip(item.skip) };
  });
  if (new Set(items.map((item) => item.positionId)).size !== items.length) invalid();
  const parsed = { revisionId: v.revisionId as string, rulesDigest: v.rulesDigest as string, next, snapshots, items };
  // The digest is recomputed here too: what the owner reads is exactly what the apply binds.
  if (privateExitRebindDigest(agentId, parsed) !== v.previewDigest) invalid();
  return { ...parsed, previewDigest: v.previewDigest as string };
}
function result(value: unknown): PrivateExitRebindResult {
  exact(value, ["operationId", "revisionId", "rulesDigest", "replayed", "items"]);
  const v = value;
  if (typeof v.operationId !== "string" || !UUID4.test(v.operationId) || typeof v.revisionId !== "string" || !REVISION.test(v.revisionId)
    || typeof v.rulesDigest !== "string" || !HEX.test(v.rulesDigest) || typeof v.replayed !== "boolean"
    || !Array.isArray(v.items) || v.items.length > PRIVATE_POSITIONS_MAX_ACTIVE) invalid();
  const items = (v.items as unknown[]).map((item): PrivateExitRebindResultItem => {
    const outcome = item && typeof item === "object" ? (item as Record<string, unknown>).outcome : undefined;
    if (outcome === "rebound") { exact(item, ["positionId", "outcome"]); }
    else if (outcome === "skipped") { exact(item, ["positionId", "outcome", "reason"]); }
    else invalid();
    if (typeof item.positionId !== "string" || !POSITION_ID.test(item.positionId)) invalid();
    return outcome === "rebound" ? { positionId: item.positionId as string, outcome: "rebound" } : { positionId: item.positionId as string, outcome: "skipped", reason: skip(item.reason) };
  });
  if (new Set(items.map((item) => item.positionId)).size !== items.length) invalid();
  return { operationId: v.operationId as string, revisionId: v.revisionId as string, rulesDigest: v.rulesDigest as string, replayed: v.replayed as boolean, items };
}

export function parsePrivateExitRebindRequest(value: unknown): PrivateExitRebindRequest {
  const action = value && typeof value === "object" ? (value as Record<string, unknown>).action : undefined;
  if (action === "preview") exact(value, [...BINDING, "action"]);
  else if (action === "apply") exact(value, Object.hasOwn(value as object, "passphrase")
    ? [...BINDING, "action", "operationId", "revisionId", "rulesDigest", "previewDigest", "passphrase"]
    : [...BINDING, "action", "operationId", "revisionId", "rulesDigest", "previewDigest"]);
  else return invalid();
  binding(value);
  if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
  if (action === "apply" && (typeof value.operationId !== "string" || !UUID4.test(value.operationId) || typeof value.revisionId !== "string"
    || !REVISION.test(value.revisionId) || typeof value.rulesDigest !== "string" || !HEX.test(value.rulesDigest)
    || typeof value.previewDigest !== "string" || !HEX.test(value.previewDigest))) invalid();
  bounded(value);
  return Object.freeze(structuredClone(value)) as unknown as PrivateExitRebindRequest;
}
export function parsePrivateExitRebindResponse(value: unknown): PrivateExitRebindResponse {
  if (!value || typeof value !== "object") invalid();
  if ((value as Record<string, unknown>).ok === true) {
    exact(value, [...BINDING, "ok", "data"]); binding(value);
    const d = value.data;
    const kind = d && typeof d === "object" ? (d as Record<string, unknown>).kind : undefined;
    let parsed: PrivateExitRebindData;
    if (kind === "preview") { exact(d, ["kind", "preview"]); parsed = { kind: "preview", preview: preview(d.preview, value.agentId as string) }; }
    else if (kind === "apply") { exact(d, ["kind", "result"]); parsed = { kind: "apply", result: result(d.result) }; }
    else return invalid();
    bounded(value);
    return Object.freeze({ channel: "private_exit_rebind", version: 1, id: value.id as string, localProfileId: value.localProfileId as string,
      instanceId: value.instanceId as string, agentId: value.agentId as string, ok: true, data: parsed }) as PrivateExitRebindResponse;
  }
  exact(value, [...BINDING, "ok", "error"]); binding(value);
  if (value.ok !== false || !PRIVATE_EXIT_REBIND_CHANNEL_ERRORS.includes(value.error as PrivateExitRebindChannelError)) invalid();
  bounded(value);
  return Object.freeze(structuredClone(value)) as unknown as PrivateExitRebindResponse;
}
function responseBinding(request: PrivateExitRebindRequest): PrivateExitRebindBinding {
  return { channel: "private_exit_rebind", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateExitRebindSuccess(request: PrivateExitRebindRequest, data: PrivateExitRebindData): PrivateExitRebindResponse {
  return validatePrivateExitRebindReply(request, { ...responseBinding(request), ok: true, data });
}
export function privateExitRebindFailure(request: PrivateExitRebindRequest, error: PrivateExitRebindChannelError): PrivateExitRebindResponse {
  return parsePrivateExitRebindResponse({ ...responseBinding(request), ok: false, error });
}
/** The reply must answer exactly this request: the binding, the data kind of its action, and for `apply` the same operation and head. */
export function validatePrivateExitRebindReply(request: PrivateExitRebindRequest, value: unknown): PrivateExitRebindResponse {
  const response = parsePrivateExitRebindResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
    || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    if (response.data.kind !== request.action) invalid();
    if (request.action === "apply" && response.data.kind === "apply" && (response.data.result.operationId !== request.operationId
      || response.data.result.revisionId !== request.revisionId || response.data.result.rulesDigest !== request.rulesDigest)) invalid();
  }
  return response;
}
export function privateExitRebindBinding(target: PrivateBrainTarget): PrivateExitRebindBinding {
  return { channel: "private_exit_rebind", version: 1, id: randomUUID(), localProfileId: target.localProfileId, instanceId: target.instanceId, agentId: target.agentId };
}
export class PrivateExitRebindTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") { super(`Local exit re-bind ${code}`); this.name = "PrivateExitRebindTransportError"; }
}
export type PrivateExitRebindTransport = (socketPath: string, request: PrivateExitRebindRequest) => Promise<PrivateExitRebindResponse>;

/** One bounded owner-socket exchange. A lost `apply` reply is `outcome_unknown` and never retried. */
export async function requestPrivateExitRebind(socketPath: string, input: PrivateExitRebindRequest): Promise<PrivateExitRebindResponse> {
  const request = parsePrivateExitRebindRequest(input);
  const mutation = request.action === "apply";
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateExitRebindTransportError("connection_unavailable"); }
  return new Promise<PrivateExitRebindResponse>((resolve, reject) => {
    const connection = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); connection.destroy();
      reject(new PrivateExitRebindTransportError(sent && mutation ? "outcome_unknown" : "connection_unavailable"));
    };
    // A2a: an apply that carries the socket proof waits for the daemon's proof deadline.
    const deadline = setTimeout(fail, Object.hasOwn(request, "passphrase") ? Math.max(TIMEOUT_MS, SOCKET_PROOF_CLIENT_TIMEOUT_MS) : TIMEOUT_MS);
    connection.once("close", fail); connection.on("error", fail);
    connection.on("connect", () => { sent = true; connection.end(encodeFrame(request)); });
    connection.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    connection.on("end", () => {
      if (settled) return;
      try { const response = validatePrivateExitRebindReply(request, reader.finish()); settled = true; clearTimeout(deadline); connection.destroy(); resolve(response); }
      catch { fail(); }
    });
  });
}
