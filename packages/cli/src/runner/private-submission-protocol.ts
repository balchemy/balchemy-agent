/** Owner-local IPC for the submission journal readback (`runner trades`), the owner's acknowledgement of an observed
 * re-signed copy (`runner wallet <agent> acknowledge-copy`; it changes nothing but the hold) and the owner's close-out of one
 * attempt (`runner trades <agent> close <attempt>`, owner decision 26: the request carries the owner's typed confirmation, which
 * the daemon checks again; the reply carries the readback and a closed `closeOut` result). Replies carry public facts only: states,
 * public transaction signatures, validated amounts, slots and timestamps; never wire bytes, keys or proofs. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { RUNNER_LOCAL_SWAP_STATES, type RunnerLocalSwapState } from "@balchemyai/agent-sdk";
import { encodeFrame, FrameReader, isId, isRecord, isTimestamp, MAX_FRAME_BYTES, RUNNER_BUY_CHECK_COUNTED, RUNNER_BUY_CHECK_REASONS, RUNNER_LANDING_RELEASE_REASONS,
  RUNNER_TRADE_CLOSE_REFUSALS, type RunnerBuyCheckReason, type RunnerLandingReleaseReason, type RunnerTradeCloseRefusal } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { isSolanaAddress } from "./solana-base58.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS, PRIVATE_STALL_EXCLUDED_ENGINE_STATES, PRIVATE_SUBMISSION_ENGINE_UNRESOLVED_STATES, PRIVATE_SUBMISSION_MAX_ATTEMPTS, PRIVATE_SUBMISSION_MAX_RESENDS, PRIVATE_SUBMISSION_READBACK_LIMIT, PRIVATE_SUBMISSION_STATES, PRIVATE_SUBMISSION_TERMINAL,
  type PrivateSubmissionReadback, type PrivateSubmissionState, type PrivateSubmissionView } from "./private-submission-journal.js";

export interface PrivateSubmissionBinding {
  channel: "private_submissions"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
/** A2a: `passphrase` (optional, acknowledge_copy and close; the parser refuses it on list) is the trading-wallet socket proof of a
 * raising change; the daemon decides whether it is required. */
export type PrivateSubmissionRequest = PrivateSubmissionBinding & ({ action: "list" | "acknowledge_copy"; passphrase?: string }
  | { action: "close"; attemptKey: string; confirmation: string; passphrase?: string });
/** Owner decision 26: the typed confirmation of one close-out, checked by the CLI and again by the daemon. */
export function privateTradeClosePhrase(attemptKey: string): string { return `CLOSE ${attemptKey}`; }
/** Owner decision 26: the result of one close-out, in the reply to a `close` request only. */
export type PrivateSubmissionCloseOutView = { attemptKey: string; outcome: "closed"; finalizedSlot: string }
  | { attemptKey: string; outcome: "refused"; reason: RunnerTradeCloseRefusal };
export type PrivateSubmissionReplyData = PrivateSubmissionReadback & { closeOut?: PrivateSubmissionCloseOutView };
export const PRIVATE_SUBMISSION_CHANNEL_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent",
  "state_unavailable", "closing",
  // A2a socket proof (private-socket-proof.ts).
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "busy", "cancelled"] as const;
export type PrivateSubmissionChannelError = typeof PRIVATE_SUBMISSION_CHANNEL_ERRORS[number];
export type PrivateSubmissionResponse = PrivateSubmissionBinding & ({ ok: true; data: PrivateSubmissionReplyData } | { ok: false; error: PrivateSubmissionChannelError });
/** Owner decision 26: a close-out runs up to four RPC reads on the owner's RPC (two expiry proofs): a longer, still bounded deadline. */
export const PRIVATE_TRADE_CLOSE_TIMEOUT_MS = 45_000;
const LIST_TIMEOUT_MS = 3_000;
const ATTEMPT_KEY = /^att:[0-9a-f]{32}$/;

const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const VIEW = ["attemptKey", "reservationId", "state", "engineState", "signature", "direction", "outputMint", "grossInLamports", "feeLamports",
  "netInLamports", "minOut", "lastValidBlockHeight", "submits", "reason", "createdAt", "updatedAt", "observedSignature", "securityHold"];
/** F2 keys that are optional on every view (absent: not released, no release check), so a CLI and a daemon of different versions
 * still read each other's `runner trades` (an older CLI refuses only a readback that actually carries one of them). */
const VIEW_OPTIONAL = ["released", "releaseCheck"];
/** SF2: the buy view may also carry `buyCheck` (a held buy negative's proof status). */
const BUY_VIEW_OPTIONAL = [...VIEW_OPTIONAL, "buyCheck"];
/** S5c exit sell view (same common fields; the sell amounts in place of the buy amounts). */
const SELL_VIEW = ["attemptKey", "reservationId", "state", "engineState", "signature", "direction", "positionId", "inputMint", "grossInUnits",
  "quotedOut", "minOut", "platformFeeBps", "lastValidBlockHeight", "submits", "reason", "createdAt", "updatedAt", "observedSignature", "securityHold"];
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
function invalid(): never { throw new Error("Invalid private submission request or response"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  const present = optional.filter((key) => Object.hasOwn(fields, key)).length;
  if (Reflect.ownKeys(value).length !== keys.length + present || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
const runnerDisputeView = (v: Record<string, unknown>): boolean => v.state === "disputed" && typeof v.reason === "string" && v.reason.startsWith("runner:");
/** SF R10: a buy view Balchemy left unresolved (the journal's privateSubmissionStalledBuy, on the view's fields): never disputed or
 * facts_pending, and never an engine state Balchemy reached after a finalized success. */
const stalledBuyView = (v: Record<string, unknown>): boolean => v.direction === "buy" && !PRIVATE_SUBMISSION_TERMINAL.includes(v.state as PrivateSubmissionState)
  && v.state !== "disputed" && v.state !== "facts_pending" && v.observedSignature === null
  && !PRIVATE_STALL_EXCLUDED_ENGINE_STATES.includes(v.engineState as RunnerLocalSwapState);
/** M3.6 slice 7 (B1): a sell view Balchemy never received (the journal's privateSubmissionUnrelayed on a sell): its proof status may be shown
 * as `releaseCheck`. */
export const privateSubmissionUnrelayedSellView = (v: Record<string, unknown>): boolean => v.direction === "sell"
  && !PRIVATE_SUBMISSION_TERMINAL.includes(v.state as PrivateSubmissionState) && v.state !== "disputed" && v.state !== "facts_pending"
  && v.observedSignature === null && v.engineState === "awaiting_signature";
/** Final audit part 3 SF-A: a sell view Balchemy relayed and leaves unresolved (the journal's privateSubmissionEngineUnresolvedSell on the
 * view's fields): its proof status may be shown as `releaseCheck`. */
export const privateSubmissionEngineUnresolvedSellView = (v: Record<string, unknown>): boolean => v.direction === "sell"
  && !PRIVATE_SUBMISSION_TERMINAL.includes(v.state as PrivateSubmissionState) && v.state !== "disputed" && v.state !== "facts_pending"
  && v.observedSignature === null && !Object.hasOwn(v, "released") && PRIVATE_SUBMISSION_ENGINE_UNRESOLVED_STATES.includes(v.engineState as RunnerLocalSwapState);
/** Owner decision 44 on a view: a buy Balchemy left unresolved that the runner has not released (closable once it is old enough). */
export function privateSubmissionUnreleasedStalledBuyView(item: PrivateSubmissionView): boolean {
  return item.released !== true && stalledBuyView(item as unknown as Record<string, unknown>);
}
/** Owner decision 44, the CLI's copy of the journal's privateSubmissionStalledBuyClosable on a view's fields: an unresolved, unreleased
 * buy at least PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS old at `nowMs`. The daemon decides again on its own clock before any proof. */
export function privateSubmissionStalledBuyClosableView(item: PrivateSubmissionView, nowMs: number): boolean {
  return privateSubmissionUnreleasedStalledBuyView(item) && Number.isSafeInteger(nowMs) && nowMs - item.createdAt >= PRIVATE_OWNER_CLOSE_STALLED_BUY_AGE_MS;
}
/** F2 optional view keys, exactly as the daemon produces them: `released` (present only as true, on a disputed attempt with a
 * `runner:` reason, or SF R10 on any buy: released while Balchemy left it unresolved, whatever status moved it to since) and
 * `releaseCheck` (a closed reason, only on a `runner:` dispute, an unresolved buy that is not released, or a sell Balchemy never received). */
function releaseKeysInvalid(v: Record<string, unknown>): boolean {
  const runner = runnerDisputeView(v);
  // Owner decision 26: a released runner dispute the owner closed out keeps `released` (closed_by_owner keeps the release as evidence).
  return (Object.hasOwn(v, "released") && (v.released !== true || (!runner && v.direction !== "buy" && v.state !== "closed_by_owner")))
    || (Object.hasOwn(v, "releaseCheck") && (!RUNNER_LANDING_RELEASE_REASONS.includes(v.releaseCheck as RunnerLandingReleaseReason)
      || (!runner && !stalledBuyView(v) && !privateSubmissionUnrelayedSellView(v) && !privateSubmissionEngineUnresolvedSellView(v)) || Object.hasOwn(v, "released")));
}
/** SF2 optional buy view key: `buyCheck` ({ reason, counted }) only on a held buy (not terminal, not a `runner:` dispute, no release
 * check) whose Balchemy record is failed_onchain or expired_not_landed, or (M3.6 D6 K1) still awaiting_signature (a buy Balchemy never
 * received, proven by the same pass); a count only for a counted reason, bounded. It may sit beside
 * `released` only on a buy released by R10 before Balchemy reported the negative. */
function buyCheckInvalid(v: Record<string, unknown>): boolean {
  if (!Object.hasOwn(v, "buyCheck")) return false;
  const check = v.buyCheck;
  if (!isRecord(check) || Reflect.ownKeys(check).length !== 2 || !Object.hasOwn(check, "reason") || !Object.hasOwn(check, "counted")) return true;
  const counted = check.counted;
  return !RUNNER_BUY_CHECK_REASONS.includes(check.reason as RunnerBuyCheckReason) || typeof counted !== "number" || !Number.isSafeInteger(counted)
    || counted < 0 || counted > 1_000 || (counted > 0 && !(RUNNER_BUY_CHECK_COUNTED as readonly string[]).includes(check.reason as string))
    || PRIVATE_SUBMISSION_TERMINAL.includes(v.state as PrivateSubmissionState)
    || (v.engineState !== "failed_onchain" && v.engineState !== "expired_not_landed" && v.engineState !== "awaiting_signature")
    || runnerDisputeView(v) || Object.hasOwn(v, "releaseCheck");
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_submissions" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
/** Closed exit sell view: the common checks of a buy view plus the sell amounts. */
function sellView(value: unknown): PrivateSubmissionView {
  exact(value, SELL_VIEW, VIEW_OPTIONAL);
  const v = value;
  if (typeof v.attemptKey !== "string" || !/^att:[0-9a-f]{32}$/.test(v.attemptKey) || typeof v.reservationId !== "string" || !UUID4.test(v.reservationId)
    || !PRIVATE_SUBMISSION_STATES.includes(v.state as PrivateSubmissionState)
    || (v.engineState !== null && !RUNNER_LOCAL_SWAP_STATES.includes(v.engineState as RunnerLocalSwapState))
    || typeof v.signature !== "string" || !TX_SIGNATURE.test(v.signature) || v.direction !== "sell"
    || typeof v.positionId !== "string" || !/^pos:[0-9a-f]{32}$/.test(v.positionId) || !isSolanaAddress(v.inputMint)
    || typeof v.platformFeeBps !== "number" || !Number.isInteger(v.platformFeeBps) || v.platformFeeBps < 0 || v.platformFeeBps > 255
    || (v.observedSignature !== null && (typeof v.observedSignature !== "string" || !TX_SIGNATURE.test(v.observedSignature) || v.observedSignature === v.signature))
    || typeof v.securityHold !== "boolean" || (v.securityHold && v.observedSignature === null)
    || releaseKeysInvalid(v)
    || ![v.grossInUnits, v.quotedOut, v.minOut, v.lastValidBlockHeight].every((item) => typeof item === "string" && U64.test(item))
    || typeof v.submits !== "number" || !Number.isSafeInteger(v.submits) || v.submits < 1 || v.submits > 1 + PRIVATE_SUBMISSION_MAX_RESENDS
    || (v.reason !== null && (typeof v.reason !== "string" || !/^[a-z0-9_:]{1,96}$/.test(v.reason)))
    || !isTimestamp(v.createdAt) || !isTimestamp(v.updatedAt) || v.updatedAt < v.createdAt) invalid();
  return Object.freeze({ ...v }) as unknown as PrivateSubmissionView;
}
function view(value: unknown): PrivateSubmissionView {
  const direction = value && typeof value === "object" && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, "direction") : undefined;
  if (direction && "value" in direction && direction.value === "sell") return sellView(value);
  exact(value, VIEW, BUY_VIEW_OPTIONAL);
  const v = value;
  if (typeof v.attemptKey !== "string" || !/^att:[0-9a-f]{32}$/.test(v.attemptKey) || typeof v.reservationId !== "string" || !UUID4.test(v.reservationId)
    || !PRIVATE_SUBMISSION_STATES.includes(v.state as PrivateSubmissionState)
    || (v.engineState !== null && !RUNNER_LOCAL_SWAP_STATES.includes(v.engineState as RunnerLocalSwapState))
    || typeof v.signature !== "string" || !TX_SIGNATURE.test(v.signature) || v.direction !== "buy" || !isSolanaAddress(v.outputMint)
    || (v.observedSignature !== null && (typeof v.observedSignature !== "string" || !TX_SIGNATURE.test(v.observedSignature) || v.observedSignature === v.signature))
    || typeof v.securityHold !== "boolean" || (v.securityHold && v.observedSignature === null)
    || releaseKeysInvalid(v) || buyCheckInvalid(v)
    || ![v.grossInLamports, v.feeLamports, v.netInLamports, v.minOut, v.lastValidBlockHeight].every((item) => typeof item === "string" && U64.test(item))
    || typeof v.submits !== "number" || !Number.isSafeInteger(v.submits) || v.submits < 1 || v.submits > 1 + PRIVATE_SUBMISSION_MAX_RESENDS
    || (v.reason !== null && (typeof v.reason !== "string" || !/^[a-z0-9_:]{1,96}$/.test(v.reason)))
    || !isTimestamp(v.createdAt) || !isTimestamp(v.updatedAt) || v.updatedAt < v.createdAt) invalid();
  return Object.freeze({ ...v }) as unknown as PrivateSubmissionView;
}

export function parsePrivateSubmissionRequest(value: unknown): PrivateSubmissionRequest {
  const action: unknown = isRecord(value) ? Object.getOwnPropertyDescriptor(value, "action")?.value : undefined;
  const close = action === "close";
  exact(value, close ? [...BINDING, "action", "attemptKey", "confirmation"] : [...BINDING, "action"],
    close || action === "acknowledge_copy" ? ["passphrase"] : []); binding(value);
  if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
  if (close) {
    if (typeof value.attemptKey !== "string" || !ATTEMPT_KEY.test(value.attemptKey) || typeof value.confirmation !== "string"
      || value.confirmation.length > 64) invalid();
  } else if (value.action !== "list" && value.action !== "acknowledge_copy") invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateSubmissionRequest;
}
/** Owner decision 26: the closed `closeOut` key of a close reply. */
function closeOutView(value: unknown): PrivateSubmissionCloseOutView {
  const closed = isRecord(value) && Object.getOwnPropertyDescriptor(value, "outcome")?.value === "closed";
  exact(value, ["attemptKey", "outcome", closed ? "finalizedSlot" : "reason"]);
  if (typeof value.attemptKey !== "string" || !ATTEMPT_KEY.test(value.attemptKey)
    || (closed ? typeof value.finalizedSlot !== "string" || !U64.test(value.finalizedSlot)
      : value.outcome !== "refused" || !RUNNER_TRADE_CLOSE_REFUSALS.includes(value.reason as RunnerTradeCloseRefusal))) invalid();
  return Object.freeze({ ...value }) as unknown as PrivateSubmissionCloseOutView;
}
export function parsePrivateSubmissionResponse(value: unknown): PrivateSubmissionResponse {
  if (!value || typeof value !== "object") invalid();
  if ((value as Record<string, unknown>).ok === true) {
    exact(value, [...BINDING, "ok", "data"]); binding(value); exact(value.data, ["agentId", "total", "attempts"], ["closeOut"]);
    const data = value.data;
    if (data.agentId !== value.agentId || typeof data.total !== "number" || !Number.isSafeInteger(data.total) || data.total < 0
      || data.total > PRIVATE_SUBMISSION_MAX_ATTEMPTS || !Array.isArray(data.attempts) || data.attempts.length > PRIVATE_SUBMISSION_READBACK_LIMIT
      || data.attempts.length > data.total) invalid();
    const attempts = (data.attempts as unknown[]).map(view);
    const closeOut = Object.hasOwn(data, "closeOut") ? closeOutView(data.closeOut) : undefined;
    bounded(value);
    return Object.freeze({ ...structuredClone(value), data: Object.freeze({ agentId: data.agentId, total: data.total, attempts,
      ...(closeOut ? { closeOut } : {}) }) }) as unknown as PrivateSubmissionResponse;
  }
  exact(value, [...BINDING, "ok", "error"]); binding(value);
  if (value.ok !== false || !PRIVATE_SUBMISSION_CHANNEL_ERRORS.includes(value.error as PrivateSubmissionChannelError)) invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivateSubmissionResponse;
}
function responseBinding(request: PrivateSubmissionRequest): PrivateSubmissionBinding {
  return { channel: "private_submissions", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateSubmissionSuccess(request: PrivateSubmissionRequest, data: PrivateSubmissionReadback, closeOut?: PrivateSubmissionCloseOutView): PrivateSubmissionResponse {
  if ((request.action === "close") !== (closeOut !== undefined) || (closeOut && request.action === "close" && closeOut.attemptKey !== request.attemptKey)) invalid();
  return parsePrivateSubmissionResponse({ ...responseBinding(request), ok: true, data: { ...data, ...(closeOut ? { closeOut: { ...closeOut } } : {}) } });
}
export function privateSubmissionFailure(request: PrivateSubmissionRequest, error: PrivateSubmissionChannelError): PrivateSubmissionResponse {
  return parsePrivateSubmissionResponse({ ...responseBinding(request), ok: false, error });
}
export function validatePrivateSubmissionReply(request: PrivateSubmissionRequest, value: unknown): PrivateSubmissionResponse {
  const response = parsePrivateSubmissionResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
    || response.agentId !== request.agentId) invalid();
  // A close-out result answers exactly the close request it belongs to; no other reply carries one.
  if (response.ok && ((request.action === "close") !== (response.data.closeOut !== undefined)
    || (request.action === "close" && response.data.closeOut?.attemptKey !== request.attemptKey))) invalid();
  return response;
}
export function privateSubmissionBinding(target: PrivateBrainTarget): PrivateSubmissionBinding {
  return { channel: "private_submissions", version: 1, id: randomUUID(), localProfileId: target.localProfileId, instanceId: target.instanceId, agentId: target.agentId };
}
export type PrivateSubmissionTransport = (socketPath: string, request: PrivateSubmissionRequest) => Promise<PrivateSubmissionResponse>;

/** One bounded owner-socket exchange (read-only except acknowledge_copy and close). */
export async function requestPrivateSubmissions(socketPath: string, input: PrivateSubmissionRequest): Promise<PrivateSubmissionResponse> {
  const request = parsePrivateSubmissionRequest(input);
  const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
  if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
    || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
    || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  return new Promise<PrivateSubmissionResponse>((resolve, reject) => {
    const connection = net.createConnection({ path: socketPath }); const reader = new FrameReader(); let settled = false;
    const fail = (): void => { if (settled) return; settled = true; clearTimeout(deadline); connection.destroy(); reject(new Error("Local runner unavailable")); };
    // A2a: an acknowledge_copy that carries the socket proof waits for the daemon's proof deadline.
    const deadline = setTimeout(fail, request.action === "close" ? PRIVATE_TRADE_CLOSE_TIMEOUT_MS + 5_000
      : Object.hasOwn(request, "passphrase") ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : LIST_TIMEOUT_MS);
    connection.once("close", fail); connection.on("error", fail);
    connection.on("connect", () => connection.end(encodeFrame(request)));
    connection.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    connection.on("end", () => {
      if (settled) return;
      try { const response = validatePrivateSubmissionReply(request, reader.finish()); settled = true; clearTimeout(deadline); connection.destroy(); resolve(response); }
      catch { fail(); }
    });
  });
}
