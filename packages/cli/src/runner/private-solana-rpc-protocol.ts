/** Owner-local IPC for the runner's own Solana RPC endpoint. A `set` request carries the full URL over
 * the owner's 0600 socket once; every reply carries the host only. No signing or execution authority. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, isId, MAX_FRAME_BYTES } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { parsePrivateSolanaRpcEndpoint } from "./private-solana-rpc.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { parsePrivateSolanaRpcSetInput, parsePrivateSolanaRpcStatus, type PrivateSolanaRpcSetInput,
  type PrivateSolanaRpcStatus } from "./private-solana-rpc-settings.js";
import { parsePrivateBalchemyRpcStatus, type PrivateBalchemyRpcStatus } from "./private-balchemy-rpc.js";

export interface PrivateSolanaRpcBinding {
  channel: "private_solana_rpc"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
/** A2a: `passphrase` (optional) is the trading-wallet socket proof of a raising change; the daemon decides whether it is required. */
export type PrivateSolanaRpcRequest = PrivateSolanaRpcBinding & ({ action: "status" } | ({ action: "set"; passphrase?: string } & PrivateSolanaRpcSetInput));
/** `positions_open` (owner decision of 17 Nov 2026): the agent is armed and has a position open, pending an exit, held or not
 * opened yet, or an unfinished trade (or the ledger could not be read), so its RPC endpoint is not changed: another endpoint
 * could leave the position without its stop-loss. Nothing was changed; the agent stays armed. */
export const PRIVATE_SOLANA_RPC_CHANNEL_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent",
  "revision_conflict", "operation_conflict", "clock_rollback", "state_unavailable", "closing", "busy", "positions_open",
  // A2a socket proof (private-socket-proof.ts).
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "cancelled"] as const;
export type PrivateSolanaRpcChannelError = typeof PRIVATE_SOLANA_RPC_CHANNEL_ERRORS[number];
/** `provided` (owner decision of 17 Nov 2026, status only): the Balchemy-provided connection of this agent (closed state, provider
 * names). Absent from an older daemon. */
export type PrivateSolanaRpcData = { kind: "status"; status: PrivateSolanaRpcStatus; provided?: PrivateBalchemyRpcStatus }
  | { kind: "set"; operationId: string; expectedRevision: number; status: PrivateSolanaRpcStatus };
export type PrivateSolanaRpcResponse = PrivateSolanaRpcBinding & ({ ok: true; data: PrivateSolanaRpcData } | { ok: false; error: PrivateSolanaRpcChannelError });

const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
function invalid(): never { throw new Error("Invalid private Solana RPC request or response"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_solana_rpc" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }

export function parsePrivateSolanaRpcRequest(value: unknown): PrivateSolanaRpcRequest {
  exact(value, [...BINDING, "action"], ["operationId", "expectedRevision", "url", "passphrase"]); binding(value);
  if (value.action === "status") { exact(value, [...BINDING, "action"]); bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateSolanaRpcRequest; }
  if (value.action !== "set") invalid();
  exact(value, [...BINDING, "action", "operationId", "expectedRevision", "url"], ["passphrase"]);
  if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
  let input: PrivateSolanaRpcSetInput;
  try { input = parsePrivateSolanaRpcSetInput({ operationId: value.operationId, expectedRevision: value.expectedRevision, url: value.url }); }
  catch { return invalid(); }
  bounded(value); return Object.freeze({ ...structuredClone(value), ...input }) as unknown as PrivateSolanaRpcRequest;
}
export function parsePrivateSolanaRpcResponse(value: unknown): PrivateSolanaRpcResponse {
  exact(value, [...BINDING, "ok"], ["data", "error"]); binding(value);
  if (value.ok === true) {
    exact(value, [...BINDING, "ok", "data"]); exact(value.data, ["kind", "status"], ["operationId", "expectedRevision", "provided"]);
    let status: PrivateSolanaRpcStatus;
    try { status = parsePrivateSolanaRpcStatus(value.data.status, value.agentId as string); } catch { return invalid(); }
    let provided: PrivateBalchemyRpcStatus | undefined;
    if (value.data.kind === "status") {
      exact(value.data, ["kind", "status"], ["provided"]);
      if (value.data.provided !== undefined) { try { provided = parsePrivateBalchemyRpcStatus(value.data.provided); } catch { return invalid(); } }
    } else if (value.data.kind === "set") {
      exact(value.data, ["kind", "status", "operationId", "expectedRevision"]);
      const expected = value.data.expectedRevision;
      if (!isId(value.data.operationId) || typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0
        || status.endpoint?.revision !== expected + 1) invalid();
    } else invalid();
    bounded(value); return Object.freeze({ ...structuredClone(value), data: Object.freeze({ ...structuredClone(value.data), status,
      ...(provided ? { provided } : {}) }) }) as unknown as PrivateSolanaRpcResponse;
  }
  if (value.ok !== false) invalid();
  exact(value, [...BINDING, "ok", "error"]);
  if (!PRIVATE_SOLANA_RPC_CHANNEL_ERRORS.includes(value.error as PrivateSolanaRpcChannelError)) invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateSolanaRpcResponse;
}
function responseBinding(request: PrivateSolanaRpcRequest): PrivateSolanaRpcBinding {
  return { channel: "private_solana_rpc", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateSolanaRpcSuccess(request: PrivateSolanaRpcRequest, data: PrivateSolanaRpcData): PrivateSolanaRpcResponse {
  return parsePrivateSolanaRpcResponse({ ...responseBinding(request), ok: true, data });
}
export function privateSolanaRpcFailure(request: PrivateSolanaRpcRequest, error: PrivateSolanaRpcChannelError): PrivateSolanaRpcResponse {
  return parsePrivateSolanaRpcResponse({ ...responseBinding(request), ok: false, error });
}
/** A `set` reply must acknowledge exactly this operation, revision and the host of the URL that was sent. */
export function validatePrivateSolanaRpcReply(request: PrivateSolanaRpcRequest, value: unknown): PrivateSolanaRpcResponse {
  const response = parsePrivateSolanaRpcResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    if (request.action === "status") { if (response.data.kind !== "status") invalid(); }
    else {
      const sent = parsePrivateSolanaRpcEndpoint(request.url); const endpoint = response.data.status.endpoint;
      if (response.data.kind !== "set" || response.data.operationId !== request.operationId || response.data.expectedRevision !== request.expectedRevision
        || !endpoint || endpoint.host !== sent.host || endpoint.transport !== sent.transport || endpoint.class !== sent.class) invalid();
    }
  }
  return response;
}

export class PrivateSolanaRpcTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") { super(`Local Solana RPC setting ${code}`); this.name = "PrivateSolanaRpcTransportError"; }
}
export type PrivateSolanaRpcTransport = (socketPath: string, request: PrivateSolanaRpcRequest) => Promise<PrivateSolanaRpcResponse>;
export function privateSolanaRpcBinding(target: PrivateBrainTarget): PrivateSolanaRpcBinding {
  return { channel: "private_solana_rpc", version: 1, id: randomUUID(), localProfileId: target.localProfileId, instanceId: target.instanceId, agentId: target.agentId };
}
/** One bounded owner-socket exchange. A lost `set` reply is unknown and never retried. */
export async function requestPrivateSolanaRpc(socketPath: string, input: PrivateSolanaRpcRequest): Promise<PrivateSolanaRpcResponse> {
  const request = parsePrivateSolanaRpcRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateSolanaRpcTransportError("connection_unavailable"); }
  return new Promise<PrivateSolanaRpcResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
      reject(new PrivateSolanaRpcTransportError(sent && request.action === "set" ? "outcome_unknown" : "connection_unavailable"));
    };
    // A2a: a set that carries the socket proof waits for the daemon's proof deadline.
    const deadline = setTimeout(fail, Object.hasOwn(request, "passphrase") ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : 3000);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateSolanaRpcReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
