/** M3 owner-local IPC for the position ledger: `list` (readback, `runner positions`), `verify` (read-only chain proof of one held
 * position) and `resolve` (the owner's typed resolution of a `runner:` hold; one compare-and-set ledger commit on a proven
 * readback, nothing signed or sent), and (owner item 75) `unmanage_check` (read-only eligibility of one completed buy whose position
 * could not open) and `unmanage` (the owner's typed confirmation; one compare-and-set ledger commit, nothing signed or sent). Local socket only: nothing here is sent to Balchemy. Replies carry public facts only:
 * states, bounded reason codes, public mints and digests, amounts and timestamps; never keys, wire bytes, proofs, RPC URLs
 * or provider payloads. Strict closed shapes: unknown keys and out-of-bound values are refused in both directions. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, isId, isTimestamp, MAX_FRAME_BYTES, RUNNER_EXIT_ENTRY_HOLDS, type RunnerExitEntryHold } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { isSolanaAddress } from "./solana-base58.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { PRIVATE_EXIT_MAX_TAKE_PROFIT_LEVELS, PRIVATE_EXIT_TRIGGERS, type PrivateExitTrigger } from "./private-exit-triggers.js";
import { PRIVATE_POSITION_STATES, PRIVATE_POSITIONS_MAX_ACTIVE, PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED, type PrivatePositionState } from "./private-positions.js";
import { PRIVATE_POSITION_PROOF_CONFLICTING, PRIVATE_POSITION_PROOF_PROVEN, PRIVATE_POSITION_PROOF_UNKNOWN, PRIVATE_POSITION_READBACK_LIMIT,
  PRIVATE_POSITION_REFUSALS, PRIVATE_POSITION_UNMANAGE_REFUSALS, PRIVATE_POSITION_UNMANAGED_LIMIT, PRIVATE_POSITION_WORKER_LIMIT, type PrivatePositionCheck,
  type PrivatePositionProof, type PrivatePositionReadback, type PrivatePositionRefusal, type PrivatePositionResolution, type PrivatePositionUnmanageBuy,
  type PrivatePositionUnmanageCheck, type PrivatePositionUnmanageRefusal, type PrivatePositionUnmanageResult, type PrivatePositionView } from "./private-position-recovery.js";
/** The owner view of one position, re-exported for the cockpit panel, commands and feed (Phase 2, K5b). */
export type { PrivatePositionView } from "./private-position-recovery.js";

export interface PrivatePositionBinding {
  channel: "private_positions"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
/** A2a: `passphrase` (optional, resolve and unmanage) is the trading-wallet socket proof of a raising change; the daemon decides. */
export type PrivatePositionRequest = PrivatePositionBinding & ({ action: "list" } | { action: "verify"; positionId: string }
  | { action: "resolve"; positionId: string; reservationId: string; result: "sold" | "not_sold"; passphrase?: string }
  | { action: "unmanage_check"; reservationId: string } | { action: "unmanage"; reservationId: string; passphrase?: string });
export type PrivatePositionData = { kind: "list"; readback: PrivatePositionReadback } | { kind: "verify"; check: PrivatePositionCheck }
  | { kind: "resolve"; resolution: PrivatePositionResolution }
  | { kind: "unmanage_check"; check: PrivatePositionUnmanageCheck } | { kind: "unmanage"; result: PrivatePositionUnmanageResult };
export const PRIVATE_POSITION_CHANNEL_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent", "state_unavailable",
  "closing", "exits_unavailable",
  // A2a socket proof (private-socket-proof.ts).
  "proof_required", "passphrase_rejected", "wallet_locked", "proof_throttled", "busy", "cancelled"] as const;
export type PrivatePositionChannelError = typeof PRIVATE_POSITION_CHANNEL_ERRORS[number];
export type PrivatePositionResponse = PrivatePositionBinding & ({ ok: true; data: PrivatePositionData } | { ok: false; error: PrivatePositionChannelError });
/** Daemon socket deadline for a verify or resolve: up to four finalized reads on the owner's RPC (10 s each) plus margin. */
export const PRIVATE_POSITION_PROOF_TIMEOUT_MS = 45_000;
const LIST_TIMEOUT_MS = 3_000;
/** Owner item 75: an unmanage check or write is local only (no RPC), one fsynced ledger write at most. */
const UNMANAGE_TIMEOUT_MS = 10_000;

const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const VIEW = ["positionId", "tokenMint", "state", "holdReason", "resolvable", "originalUnits", "remainingUnits", "costLamports", "proceedsLamports",
  "proceedsComplete", "pendingExit", "exits", "createdAt", "updatedAt", "settlement", "balance"];
const POSITION_ID = /^pos:[0-9a-f]{32}$/;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const REASON = /^[a-z0-9_:]{1,96}$/;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
function invalid(): never { throw new Error("Invalid private position request or response"); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_positions" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
const u64 = (value: unknown): boolean => typeof value === "string" && U64.test(value) && BigInt(value) <= U64_MAX;
const count = (value: unknown, maximum: number): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const reason = (value: unknown): boolean => typeof value === "string" && REASON.test(value);

function view(value: unknown): PrivatePositionView {
  exact(value, VIEW);
  const v = value;
  if (typeof v.positionId !== "string" || !POSITION_ID.test(v.positionId) || !isSolanaAddress(v.tokenMint)
    || !PRIVATE_POSITION_STATES.includes(v.state as PrivatePositionState) || (v.holdReason !== null && !reason(v.holdReason))
    || (v.state === "held") !== (v.holdReason !== null) || typeof v.resolvable !== "boolean"
    || v.resolvable !== (v.state === "held" && typeof v.holdReason === "string" && v.holdReason.startsWith("runner:"))
    || ![v.originalUnits, v.remainingUnits, v.costLamports, v.proceedsLamports].every(u64) || BigInt(v.remainingUnits as string) > BigInt(v.originalUnits as string)
    || BigInt(v.originalUnits as string) < 1n || (v.state === "closed") !== (v.remainingUnits === "0")
    || !count(v.exits, 20) || !isTimestamp(v.createdAt) || !isTimestamp(v.updatedAt) || v.updatedAt < v.createdAt) invalid();
  let pending: PrivatePositionView["pendingExit"] = null;
  if (v.pendingExit !== null) {
    const p = v.pendingExit; exact(p, ["reservationId", "trigger", "level", "units", "createdAt"]);
    if (typeof p.reservationId !== "string" || !UUID4.test(p.reservationId) || !PRIVATE_EXIT_TRIGGERS.includes(p.trigger as PrivateExitTrigger)
      || (p.level !== null && !count(p.level, PRIVATE_EXIT_MAX_TAKE_PROFIT_LEVELS - 1)) || (p.trigger === "take_profit") !== (p.level !== null) || !u64(p.units) || p.units === "0"
      || BigInt(p.units as string) > BigInt(v.remainingUnits as string) || !isTimestamp(p.createdAt)) invalid();
    pending = { reservationId: p.reservationId, trigger: p.trigger as string, level: p.level as number | null, units: p.units as string, createdAt: p.createdAt };
  }
  if ((v.state === "held" && pending === null) || (v.state === "closed" && pending !== null)) invalid();
  if (typeof v.proceedsComplete !== "boolean" || (!v.proceedsComplete && v.exits === 0)) invalid();
  let settlement: PrivatePositionView["settlement"] = null;
  if (v.settlement !== null) {
    const s = v.settlement; exact(s, ["result", "reason", "heldFor", "at"]);
    if ((s.result !== "sold" && s.result !== "not_sold") || !reason(s.reason) || !reason(s.heldFor) || !(s.heldFor as string).startsWith("runner:")
      || !isTimestamp(s.at) || s.at > (v.updatedAt as number) || (s.result === "sold" && v.proceedsComplete)) invalid();
    settlement = { result: s.result as "sold" | "not_sold", reason: s.reason as string, heldFor: s.heldFor as string, at: s.at as number };
  }
  let balance: PrivatePositionView["balance"] = null;
  if (v.balance !== null) {
    const b = v.balance; exact(b, ["reason", "tries", "nextAt"]);
    // Only a position the automatic check is for (held with a `runner:` reason) carries one.
    if (!reason(b.reason) || !count(b.tries, 1_000_000_000) || b.tries === 0 || !isTimestamp(b.nextAt) || !v.resolvable) invalid();
    balance = { reason: b.reason as string, tries: b.tries as number, nextAt: b.nextAt as number };
  }
  return { positionId: v.positionId, tokenMint: v.tokenMint as string, state: v.state as PrivatePositionState, holdReason: v.holdReason as string | null,
    resolvable: v.resolvable, originalUnits: v.originalUnits as string, remainingUnits: v.remainingUnits as string, costLamports: v.costLamports as string,
    proceedsLamports: v.proceedsLamports as string, proceedsComplete: v.proceedsComplete, pendingExit: pending, exits: v.exits as number, createdAt: v.createdAt,
    updatedAt: v.updatedAt as number, settlement, balance };
}
function proof(value: unknown): PrivatePositionProof {
  exact(value, ["outcome", "result", "reason", "proceedsLamports"]);
  const v = value;
  const ok = v.outcome === "proven"
    ? (v.result === "sold" ? v.reason === "finalized_sale" && u64(v.proceedsLamports)
      : v.result === "not_sold" && v.reason === "finalized_failed" && v.proceedsLamports === null)
      && (PRIVATE_POSITION_PROOF_PROVEN as readonly unknown[]).includes(v.reason)
    : v.outcome === "unknown" ? v.result === null && v.proceedsLamports === null && (PRIVATE_POSITION_PROOF_UNKNOWN as readonly unknown[]).includes(v.reason)
      : v.outcome === "conflicting" && v.result === null && v.proceedsLamports === null && (PRIVATE_POSITION_PROOF_CONFLICTING as readonly unknown[]).includes(v.reason);
  if (!ok) invalid();
  return Object.freeze({ ...v }) as unknown as PrivatePositionProof;
}
function refusal(value: unknown): PrivatePositionRefusal | null {
  if (value !== null && !PRIVATE_POSITION_REFUSALS.includes(value as PrivatePositionRefusal)) invalid();
  return value as PrivatePositionRefusal | null;
}
function check(value: unknown, keys: readonly string[]): PrivatePositionResolution | PrivatePositionCheck {
  exact(value, keys);
  const v = value;
  if (typeof v.positionId !== "string" || !POSITION_ID.test(v.positionId)) invalid();
  const result: PrivatePositionResolution = { positionId: v.positionId, applied: v.applied === true, refusal: refusal(v.refusal),
    proof: v.proof === null ? null : proof(v.proof), position: v.position === null ? null : view(v.position) };
  if (result.position && result.position.positionId !== result.positionId) invalid();
  // No refusal means a proof was made; proof_changed always carries the fresh proof.
  if ((result.refusal === null || result.refusal === "proof_changed") && result.proof === null) invalid();
  if (keys.includes("applied")) {
    if (typeof v.applied !== "boolean" || (v.applied && (result.refusal !== null || result.proof?.outcome !== "proven" || !result.position))) invalid();
    return result;
  }
  const { applied: _applied, ...rest } = result;
  return rest;
}
/** Owner item 75: refusal null <=> an eligible buy is shown; a result is applied exactly when it carries no refusal. */
function unmanageCheck(value: unknown, keys: readonly string[]): PrivatePositionUnmanageResult | PrivatePositionUnmanageCheck {
  exact(value, keys);
  const v = value;
  if (typeof v.reservationId !== "string" || !UUID4.test(v.reservationId)
    || (v.refusal !== null && !PRIVATE_POSITION_UNMANAGE_REFUSALS.includes(v.refusal as PrivatePositionUnmanageRefusal))) invalid();
  let buy: PrivatePositionUnmanageBuy | null = null;
  if (v.buy !== null) {
    const b = v.buy; exact(b, ["reservationId", "tokenMint", "costLamports", "completedAt", "opening"]);
    const o = b.opening; exact(o, ["reason", "kind", "tries"]);
    if (b.reservationId !== v.reservationId || !isSolanaAddress(b.tokenMint) || !u64(b.costLamports) || !isTimestamp(b.completedAt)
      || !reason(o.reason) || (o.kind !== "transient" && o.kind !== "permanent") || !count(o.tries, 1_000_000_000) || o.tries === 0) invalid();
    buy = { reservationId: v.reservationId, tokenMint: b.tokenMint as string, costLamports: b.costLamports as string, completedAt: b.completedAt as number,
      opening: { reason: o.reason as string, kind: o.kind as "transient" | "permanent", tries: o.tries as number } };
  }
  if ((v.refusal === null) !== (buy !== null)) invalid();
  const check: PrivatePositionUnmanageCheck = { reservationId: v.reservationId, refusal: v.refusal as PrivatePositionUnmanageRefusal | null, buy };
  if (!keys.includes("applied")) return check;
  if (typeof v.applied !== "boolean" || v.applied !== (check.refusal === null)) invalid();
  return { ...check, applied: v.applied as boolean };
}
function readback(value: unknown): PrivatePositionReadback {
  if (value && typeof value === "object" && (value as Record<string, unknown>).exits === "unavailable") {
    // F-M36-D15-SF11: `ledger` is optional (sent only when the ledger holds an open or held position, or cannot be read).
    const has = Object.hasOwn(value, "ledger");
    exact(value, ["agentId", "exits", ...(has ? ["ledger"] : [])]); if (!isId(value.agentId)) invalid();
    if (!has) return { agentId: value.agentId, exits: "unavailable" };
    if (value.ledger === "unreadable") return { agentId: value.agentId, exits: "unavailable", ledger: "unreadable" };
    const l = value.ledger; exact(l, ["total", "positions"]);
    if (!count(l.total, PRIVATE_POSITIONS_MAX_ACTIVE) || l.total === 0 || !Array.isArray(l.positions) || l.positions.length === 0
      || l.positions.length > PRIVATE_POSITION_READBACK_LIMIT || l.positions.length > (l.total as number)
      || (l.positions.length < (l.total as number) && l.positions.length < PRIVATE_POSITION_READBACK_LIMIT)) invalid();
    const positions = (l.positions as unknown[]).map(view);
    if (positions.some((item) => item.state === "closed") || new Set(positions.map((item) => item.positionId)).size !== positions.length) invalid();
    return { agentId: value.agentId, exits: "unavailable", ledger: { total: l.total as number, positions } };
  }
  // SF-A review finding 4: `lateLandings` is optional (sent only when non-empty), so runners of other versions read every other readback.
  const late = !!value && typeof value === "object" && Object.hasOwn(value, "lateLandings");
  // Final audit N5: `hubReason` is optional too (sent only while it is "clock_skew").
  const hub = !!value && typeof value === "object" && Object.hasOwn(value, "hubReason");
  exact(value, ["agentId", "exits", "entryHold", "worker", "total", "positions", "managedSince", "unmanagedTotal", "unmanaged", "ownerUnmanagedTotal", "ownerUnmanaged",
    ...(late ? ["lateLandings"] : []), ...(hub ? ["hubReason"] : [])]);
  const v = value;
  if (hub && v.hubReason !== "clock_skew") invalid();
  let lateLandings: string[] | undefined;
  if (late) {
    const ids = v.lateLandings;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > PRIVATE_POSITION_READBACK_LIMIT
      || !(ids as unknown[]).every((id) => typeof id === "string" && POSITION_ID.test(id)) || new Set(ids).size !== ids.length) invalid();
    lateLandings = [...(ids as string[])];
  }
  if ((v.managedSince !== null && !isTimestamp(v.managedSince)) || !count(v.unmanagedTotal, 128) || !Array.isArray(v.unmanaged)
    || v.unmanaged.length > PRIVATE_POSITION_UNMANAGED_LIMIT || v.unmanaged.length > (v.unmanagedTotal as number)
    || (v.unmanaged.length < (v.unmanagedTotal as number) && v.unmanaged.length < PRIVATE_POSITION_UNMANAGED_LIMIT)
    || (v.managedSince === null && v.unmanagedTotal !== 0)) invalid();
  const unmanaged = (v.unmanaged as unknown[]).map((item) => {
    exact(item, ["reservationId", "tokenMint", "costLamports", "completedAt"]);
    if (typeof item.reservationId !== "string" || !UUID4.test(item.reservationId) || !isSolanaAddress(item.tokenMint) || !u64(item.costLamports)
      || !isTimestamp(item.completedAt)) invalid();
    return { reservationId: item.reservationId as string, tokenMint: item.tokenMint as string, costLamports: item.costLamports as string, completedAt: item.completedAt as number };
  });
  if (new Set(unmanaged.map((item) => item.reservationId)).size !== unmanaged.length) invalid();
  // Owner item 75: owner-unmanaged buys (newest first, bounded like the pre-enable list).
  if (!count(v.ownerUnmanagedTotal, PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED) || !Array.isArray(v.ownerUnmanaged)
    || v.ownerUnmanaged.length > PRIVATE_POSITION_UNMANAGED_LIMIT || v.ownerUnmanaged.length > (v.ownerUnmanagedTotal as number)
    || (v.ownerUnmanaged.length < (v.ownerUnmanagedTotal as number) && v.ownerUnmanaged.length < PRIVATE_POSITION_UNMANAGED_LIMIT)
    || (v.managedSince === null && v.ownerUnmanagedTotal !== 0)) invalid();
  const ownerUnmanaged = (v.ownerUnmanaged as unknown[]).map((item) => {
    exact(item, ["reservationId", "tokenMint", "at"]);
    if (typeof item.reservationId !== "string" || !UUID4.test(item.reservationId) || !isSolanaAddress(item.tokenMint) || !isTimestamp(item.at)) invalid();
    return { reservationId: item.reservationId, tokenMint: item.tokenMint as string, at: item.at as number };
  });
  if (new Set(ownerUnmanaged.map((item) => item.reservationId)).size !== ownerUnmanaged.length) invalid();
  if (!isId(v.agentId) || v.exits !== "available" || (v.entryHold !== null && !RUNNER_EXIT_ENTRY_HOLDS.includes(v.entryHold as RunnerExitEntryHold))
    || !count(v.total, 128) || !Array.isArray(v.positions) || v.positions.length > PRIVATE_POSITION_READBACK_LIMIT
    || v.positions.length > (v.total as number)
    || (v.positions.length < (v.total as number) && v.positions.length < PRIVATE_POSITION_READBACK_LIMIT)) invalid();
  const positions = (v.positions as unknown[]).map(view);
  if (new Set(positions.map((item) => item.positionId)).size !== positions.length) invalid();
  let worker: Extract<PrivatePositionReadback, { exits: "available" }>["worker"] = null;
  if (v.worker !== null) {
    const w = v.worker; exact(w, ["reason", "openingTotal", "opening", "backoffTotal", "backoff"]);
    if ((w.reason !== null && !reason(w.reason)) || !count(w.openingTotal, 256) || !count(w.backoffTotal, 256) || !Array.isArray(w.opening)
      || !Array.isArray(w.backoff) || w.opening.length > PRIVATE_POSITION_WORKER_LIMIT || w.backoff.length > PRIVATE_POSITION_WORKER_LIMIT
      || w.opening.length > (w.openingTotal as number) || w.backoff.length > (w.backoffTotal as number)) invalid();
    const opening = (w.opening as unknown[]).map((item) => {
      exact(item, ["buildDigest", "reservationId", "reason", "tries", "kind"]);
      if (typeof item.buildDigest !== "string" || !HEX.test(item.buildDigest) || !reason(item.reason) || !count(item.tries, 1_000_000_000) || item.tries === 0
        || (item.kind !== "transient" && item.kind !== "permanent") || (item.reservationId !== null && (typeof item.reservationId !== "string" || !UUID4.test(item.reservationId)))) invalid();
      return { buildDigest: item.buildDigest, reservationId: item.reservationId as string | null, reason: item.reason as string, tries: item.tries as number,
        kind: item.kind as "transient" | "permanent" };
    });
    const backoff = (w.backoff as unknown[]).map((item) => {
      exact(item, ["positionId", "reason", "failures", "untilMs"]);
      if (typeof item.positionId !== "string" || !POSITION_ID.test(item.positionId) || !reason(item.reason) || !count(item.failures, 1_000_000_000)
        || item.failures === 0 || !isTimestamp(item.untilMs)) invalid();
      return { positionId: item.positionId, reason: item.reason as string, failures: item.failures as number, untilMs: item.untilMs };
    });
    worker = { reason: w.reason as string | null, openingTotal: w.openingTotal as number, opening, backoffTotal: w.backoffTotal as number, backoff };
  }
  return { agentId: v.agentId, exits: "available", entryHold: v.entryHold as RunnerExitEntryHold | null, worker, total: v.total as number, positions,
    managedSince: v.managedSince as number | null, unmanagedTotal: v.unmanagedTotal as number, unmanaged,
    ownerUnmanagedTotal: v.ownerUnmanagedTotal as number, ownerUnmanaged, ...(lateLandings ? { lateLandings } : {}), ...(hub ? { hubReason: "clock_skew" as const } : {}) };
}
function data(value: unknown, agentId: string, request?: PrivatePositionRequest): PrivatePositionData {
  if (!value || typeof value !== "object") invalid();
  const kind = (value as Record<string, unknown>).kind;
  if (kind === "list") {
    exact(value, ["kind", "readback"]); const result = readback(value.readback);
    if (result.agentId !== agentId) invalid();
    return { kind, readback: result };
  }
  if (kind === "verify") { exact(value, ["kind", "check"]); return { kind, check: check(value.check, ["positionId", "refusal", "proof", "position"]) }; }
  if (kind === "resolve") {
    exact(value, ["kind", "resolution"]);
    const resolution = check(value.resolution, ["positionId", "applied", "refusal", "proof", "position"]) as PrivatePositionResolution;
    // An applied resolution is exactly the confirmed result, and the position no longer carries that pending exit.
    if (request?.action === "resolve" && resolution.applied && (resolution.proof?.result !== request.result
      || resolution.position?.pendingExit?.reservationId === request.reservationId || resolution.position?.state === "held")) invalid();
    return { kind, resolution };
  }
  if (kind === "unmanage_check") {
    exact(value, ["kind", "check"]);
    return { kind, check: unmanageCheck(value.check, ["reservationId", "refusal", "buy"]) };
  }
  if (kind === "unmanage") {
    exact(value, ["kind", "result"]);
    return { kind, result: unmanageCheck(value.result, ["reservationId", "applied", "refusal", "buy"]) as PrivatePositionUnmanageResult };
  }
  return invalid();
}

export function parsePrivatePositionRequest(value: unknown): PrivatePositionRequest {
  const action = value && typeof value === "object" ? (value as Record<string, unknown>).action : undefined;
  const proof = (action === "resolve" || action === "unmanage") && Object.hasOwn(value as object, "passphrase") ? ["passphrase"] : [];
  if (action === "list") exact(value, [...BINDING, "action"]);
  else if (action === "verify") exact(value, [...BINDING, "action", "positionId"]);
  else if (action === "resolve") exact(value, [...BINDING, "action", "positionId", "reservationId", "result", ...proof]);
  else if (action === "unmanage_check" || action === "unmanage") exact(value, [...BINDING, "action", "reservationId", ...proof]);
  else return invalid();
  binding(value);
  if (proof.length && !isTradingWalletPassphrase(value.passphrase)) invalid();
  if ((action === "verify" || action === "resolve") && (typeof value.positionId !== "string" || !POSITION_ID.test(value.positionId))) invalid();
  if ((action === "unmanage_check" || action === "unmanage") && (typeof value.reservationId !== "string" || !UUID4.test(value.reservationId))) invalid();
  if (action === "resolve" && (typeof value.reservationId !== "string" || !UUID4.test(value.reservationId)
    || (value.result !== "sold" && value.result !== "not_sold"))) invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivatePositionRequest;
}
export function parsePrivatePositionResponse(value: unknown, request?: PrivatePositionRequest): PrivatePositionResponse {
  if (!value || typeof value !== "object") invalid();
  if ((value as Record<string, unknown>).ok === true) {
    exact(value, [...BINDING, "ok", "data"]); binding(value);
    const parsed = data(value.data, value.agentId as string, request);
    bounded(value);
    return Object.freeze({ ...structuredClone(value), data: parsed }) as unknown as PrivatePositionResponse;
  }
  exact(value, [...BINDING, "ok", "error"]); binding(value);
  if (value.ok !== false || !PRIVATE_POSITION_CHANNEL_ERRORS.includes(value.error as PrivatePositionChannelError)) invalid();
  bounded(value); return Object.freeze(structuredClone(value)) as unknown as PrivatePositionResponse;
}
function responseBinding(request: PrivatePositionRequest): PrivatePositionBinding {
  return { channel: "private_positions", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privatePositionSuccess(request: PrivatePositionRequest, value: PrivatePositionData): PrivatePositionResponse {
  return parsePrivatePositionResponse({ ...responseBinding(request), ok: true, data: value }, request);
}
export function privatePositionFailure(request: PrivatePositionRequest, error: PrivatePositionChannelError): PrivatePositionResponse {
  return parsePrivatePositionResponse({ ...responseBinding(request), ok: false, error });
}
/** A reply must answer exactly this request: the binding, and the data kind of its action. */
export function validatePrivatePositionReply(request: PrivatePositionRequest, value: unknown): PrivatePositionResponse {
  const response = parsePrivatePositionResponse(value, request);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId || response.instanceId !== request.instanceId
    || response.agentId !== request.agentId) invalid();
  if (response.ok && (response.data.kind !== request.action
    || (response.data.kind === "verify" && request.action === "verify" && response.data.check.positionId !== request.positionId)
    || (response.data.kind === "resolve" && request.action === "resolve" && response.data.resolution.positionId !== request.positionId)
    || (response.data.kind === "unmanage_check" && request.action === "unmanage_check" && response.data.check.reservationId !== request.reservationId)
    || (response.data.kind === "unmanage" && request.action === "unmanage" && response.data.result.reservationId !== request.reservationId))) invalid();
  return response;
}
export function privatePositionBinding(target: PrivateBrainTarget): PrivatePositionBinding {
  return { channel: "private_positions", version: 1, id: randomUUID(), localProfileId: target.localProfileId, instanceId: target.instanceId, agentId: target.agentId };
}
export type PrivatePositionTransport = (socketPath: string, request: PrivatePositionRequest) => Promise<PrivatePositionResponse>;

/** One bounded owner-socket exchange (a longer deadline for a verify or resolve, which waits on the owner's RPC). */
export async function requestPrivatePositions(socketPath: string, input: PrivatePositionRequest): Promise<PrivatePositionResponse> {
  const request = parsePrivatePositionRequest(input);
  const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
  if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
    || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
    || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  const base = request.action === "list" ? LIST_TIMEOUT_MS : request.action === "unmanage_check" || request.action === "unmanage" ? UNMANAGE_TIMEOUT_MS
    : PRIVATE_POSITION_PROOF_TIMEOUT_MS + 5_000;
  // A2a: a resolve or unmanage that carries the socket proof waits at least for the daemon's proof deadline.
  const timeoutMs = Object.hasOwn(request, "passphrase") ? Math.max(base, SOCKET_PROOF_CLIENT_TIMEOUT_MS) : base;
  return new Promise<PrivatePositionResponse>((resolve, reject) => {
    const connection = net.createConnection({ path: socketPath }); const reader = new FrameReader(); let settled = false;
    const fail = (): void => { if (settled) return; settled = true; clearTimeout(deadline); connection.destroy(); reject(new Error("Local runner unavailable")); };
    const deadline = setTimeout(fail, timeoutMs);
    connection.once("close", fail); connection.on("error", fail);
    connection.on("connect", () => connection.end(encodeFrame(request)));
    connection.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    connection.on("end", () => {
      if (settled) return;
      try { const response = validatePrivatePositionReply(request, reader.finish()); settled = true; clearTimeout(deadline); connection.destroy(); resolve(response); }
      catch { fail(); }
    });
  });
}
