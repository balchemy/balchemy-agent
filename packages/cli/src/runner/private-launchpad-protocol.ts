/** K4 launchpad sources IPC (channel `private_launchpads`, owner socket only; the cockpit `/signals` and `balchemy runner signals`).
 * `status` reads the public catalog and the agent's subscription; `set` replaces the subscription with exactly the given live ids
 * (`[]` unsubscribes). Public facts only: never a key, nonce, proof, signature or URL. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { RUNNER_LAUNCHPAD_ID, RUNNER_LAUNCHPAD_MAX_SUBSCRIPTIONS } from "@balchemyai/agent-sdk";
import { encodeFrame, FrameReader, isId, MAX_FRAME_BYTES } from "./protocol.js";
import { PRIVATE_LAUNCHPAD_ERRORS, type PrivateLaunchpadErrorCode, type PrivateLaunchpadView } from "./private-launchpads.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";

export const PRIVATE_LAUNCHPAD_CHANNEL_ERRORS = [...PRIVATE_LAUNCHPAD_ERRORS, "profile_conflict", "instance_conflict", "launchpads_unavailable",
  // A2a socket proof (private-socket-proof.ts).
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "busy", "cancelled"] as const;
export type PrivateLaunchpadChannelError = typeof PRIVATE_LAUNCHPAD_CHANNEL_ERRORS[number];
export interface PrivateLaunchpadFrame { channel: "private_launchpads"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string }
/** A2a: `passphrase` (optional) is the trading-wallet socket proof of a raising change; the daemon decides whether it is required. */
export type PrivateLaunchpadRequest = PrivateLaunchpadFrame & ({ action: "status" } | { action: "set"; launchpadIds: string[]; passphrase?: string });
export type PrivateLaunchpadResponse = PrivateLaunchpadFrame & ({ ok: true; view: PrivateLaunchpadView } | { ok: false; error: PrivateLaunchpadChannelError });

const FRAME = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
/** The daemon's bound for one exchange (a catalog read and up to two runner-signed queries); the client waits a little longer. */
export const PRIVATE_LAUNCHPAD_TIMEOUT_MS = 40_000;
const TIMEOUT_MS = PRIVATE_LAUNCHPAD_TIMEOUT_MS + 5_000;
export class PrivateLaunchpadProtocolError extends Error {
  constructor() { super("Invalid local launchpad message"); this.name = "PrivateLaunchpadProtocolError"; }
}
function invalid(): never { throw new PrivateLaunchpadProtocolError(); }
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
function frame(value: Record<string, unknown>): void {
  if (value.channel !== "private_launchpads" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); } catch { invalid(); }
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > RUNNER_LAUNCHPAD_MAX_SUBSCRIPTIONS
    || Reflect.ownKeys(value).length !== value.length + 1) invalid();
  const list = value as unknown[];
  list.forEach((item, index) => { if (typeof item !== "string" || !RUNNER_LAUNCHPAD_ID.test(item) || (index > 0 && (list[index - 1] as string) >= item)) invalid(); });
  return [...list] as string[];
}
function view(value: unknown): PrivateLaunchpadView {
  exact(value, ["revision", "launchpads", "subscribedIds", "updatedAt"]);
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0
    || (value.updatedAt !== null && typeof value.updatedAt !== "string") || !Array.isArray(value.launchpads) || value.launchpads.length > 64) invalid();
  const subscribedIds = ids(value.subscribedIds);
  const launchpads = (value.launchpads as unknown[]).map((entry) => {
    exact(entry, ["id", "name", "status", "sourceNote", "subscribed"]);
    if (typeof entry.id !== "string" || !RUNNER_LAUNCHPAD_ID.test(entry.id) || typeof entry.name !== "string" || entry.name.length > 64
      || (entry.status !== "live" && entry.status !== "coming_soon") || typeof entry.sourceNote !== "string" || entry.sourceNote.length > 512
      || entry.subscribed !== subscribedIds.includes(entry.id)) invalid();
    return { id: entry.id, name: entry.name, status: entry.status, sourceNote: entry.sourceNote, subscribed: entry.subscribed } as PrivateLaunchpadView["launchpads"][number];
  });
  return { revision: value.revision, launchpads, subscribedIds, updatedAt: value.updatedAt as string | null };
}
export function parsePrivateLaunchpadRequest(value: unknown): PrivateLaunchpadRequest {
  const action = field(value, "action");
  if (action === "status") exact(value, [...FRAME, "action"]);
  else if (action === "set") exact(value, Object.hasOwn(value as object, "passphrase") ? [...FRAME, "action", "launchpadIds", "passphrase"] : [...FRAME, "action", "launchpadIds"]);
  else invalid();
  frame(value);
  if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
  return Object.freeze(action === "set" ? { ...value, launchpadIds: ids(value.launchpadIds) } : { ...value }) as unknown as PrivateLaunchpadRequest;
}
export function parsePrivateLaunchpadResponse(value: unknown): PrivateLaunchpadResponse {
  const ok = field(value, "ok");
  if (ok === true) exact(value, [...FRAME, "ok", "view"]);
  else if (ok === false) exact(value, [...FRAME, "ok", "error"]);
  else invalid();
  frame(value);
  if (ok === false) {
    if (!PRIVATE_LAUNCHPAD_CHANNEL_ERRORS.includes(value.error as PrivateLaunchpadChannelError)) invalid();
    return Object.freeze({ ...value }) as unknown as PrivateLaunchpadResponse;
  }
  return Object.freeze({ ...value, view: view(value.view) }) as unknown as PrivateLaunchpadResponse;
}
function responseFrame(request: PrivateLaunchpadRequest): PrivateLaunchpadFrame {
  return { channel: "private_launchpads", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateLaunchpadSuccess(request: PrivateLaunchpadRequest, value: PrivateLaunchpadView): PrivateLaunchpadResponse {
  return parsePrivateLaunchpadResponse({ ...responseFrame(request), ok: true, view: structuredClone(value) });
}
export function privateLaunchpadFailure(request: PrivateLaunchpadRequest, error: PrivateLaunchpadChannelError | PrivateLaunchpadErrorCode): PrivateLaunchpadResponse {
  return parsePrivateLaunchpadResponse({ ...responseFrame(request), ok: false, error });
}
export function validatePrivateLaunchpadReply(request: PrivateLaunchpadRequest, value: unknown): PrivateLaunchpadResponse {
  const response = parsePrivateLaunchpadResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
    || response.agentId !== request.agentId) invalid();
  return response;
}
export function privateLaunchpadRequest(target: PrivateBrainTarget, input: { action: "status" } | { action: "set"; launchpadIds: string[] }): PrivateLaunchpadRequest {
  return parsePrivateLaunchpadRequest({ channel: "private_launchpads", version: 1, id: randomUUID(), localProfileId: target.localProfileId,
    instanceId: target.instanceId, agentId: target.agentId, ...input });
}

export type PrivateLaunchpadTransport = (socketPath: string, request: PrivateLaunchpadRequest) => Promise<PrivateLaunchpadResponse>;
/** One bounded owner-socket exchange. A lost `set` reply leaves the outcome unknown; `status` shows the stored result. */
export async function requestPrivateLaunchpads(socketPath: string, input: PrivateLaunchpadRequest): Promise<PrivateLaunchpadResponse> {
  const request = parsePrivateLaunchpadRequest(input);
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateLaunchpadProtocolError(); }
  return new Promise<PrivateLaunchpadResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let settled = false;
    const fail = (): void => { if (settled) return; settled = true; clearTimeout(deadline); socket.destroy(); reject(new PrivateLaunchpadProtocolError()); };
    const deadline = setTimeout(fail, TIMEOUT_MS);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try { const response = validatePrivateLaunchpadReply(request, reader.finish()); settled = true; clearTimeout(deadline); socket.destroy(); resolve(response); }
      catch { fail(); }
    });
  });
}
