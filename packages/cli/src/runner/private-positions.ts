/** S5c owner-local position ledger: one fsynced snapshot per agent (OwnedJsonSnapshot under the daemon's existing exclusive
 * writer; this ledger never takes a second lock). Bounded and fail closed.
 *
 * - One position per completed BUY (positionId derives from its engine build digest): each entry keeps the exit snapshot of
 *   the plan that opened it, its exact cost and units, its own ladder and high-water mark. A later buy of the same mint can
 *   never silently change an earlier position's protection; Balchemy's engine position (wallet, mint) stays the server cap.
 * - A position opens only from a buy Balchemy reported `completed` AND whose exact token units the runner proved itself from
 *   the finalized transaction on its own RPC (private-position-facts.ts). Opening is idempotent per build digest.
 * - At most one pending exit per position: a duplicate trigger while one is pending is refused (exit_pending). A completed
 *   exit reduces the remaining units by exactly the units it sold (the engine's sell input debit) and records the proceeds
 *   (net of the network fee the sale paid, private-position-facts.ts);
 *   completion is idempotent per reservation. A proven negative (failed_onchain, expired_not_landed, build_revoked, a refusal
 *   before any bytes) clears the pending exit so the next valuation may trigger again; an unknown outcome holds the position
 *   (no new trigger) until reconciliation proves either completion or a negative.
 * - The trailing state only moves forward: once armed it stays armed and the high-water mark never decreases.
 * - L5 byte bounds: the snapshot never exceeds PRIVATE_POSITIONS_MAX_LEDGER_BYTES. Every position is bounded by its shape (at most
 *   16 ladder levels and 20 exits, bounded fields) to PRIVATE_POSITION_MAX_BYTES, and PRIVATE_POSITIONS_MAX_ACTIVE such positions
 *   always fit, so open and held positions (all unsettled state) can never be crowded out. Before a commit that would pass the
 *   byte cap, settled history is compacted: the oldest CLOSED positions (nothing remains, nothing pending; never one changed by
 *   this very commit) are evicted, as the closed-count bound already does. A commit that still does not fit, or a position
 *   above its own bound, is refused `ledger_full` before any write: the previous snapshot stays intact and readable (no held
 *   store), the caller's state is unchanged (an open refused stays unopened and holds entries, a completion stays pending).
 * - Evicted positions never reopen: every eviction records the position's entry reservationId in a bounded list
 *   (PRIVATE_POSITIONS_MAX_EVICTED) and `open` refuses any of them (`position_evicted`), whatever the journal still holds or in
 *   which order (a clock step can invert the journal's eviction order). An id is forgotten only through `forgetEvicted`, which
 *   the exit worker calls with the journal's own buy attempts: once a buy has left the journal it can never be presented again.
 *   An eviction that would overflow the list is refused `ledger_full` before any write (the next worker pass forgets ids whose
 *   buy left the journal; the journal holds at most 64 attempts, so the list never stays full).
 * - Enable-time cutoff (owner decision of 11 Nov 2026: only buys completed after automatic exits were enabled are managed):
 *   `managedFrom` is recorded once, idempotently, the first time the exit worker runs for an agent (before any buy can be built
 *   under the capability). It is a journal watermark, not a wall-clock time: the entry reservationIds of every COMPLETED buy
 *   attempt the journal held at that moment without a position, and their output mints. Those buys are never opened
 *   (`position_not_managed`), whatever the clock does later; every other buy is, including one still unfinished at that moment
 *   (it completes after enabling, so it opens through the usual intent, job and plan checks). The mints are kept for good: the
 *   wallet-balance settlement never settles a hold of such a mint, because unmanaged units of it may be in the wallet long after
 *   their attempts left the journal. Ledgers written before it existed read without it and record it on first use.
 * - Wallet-balance settlement (owner decision of 11 Nov 2026, private-position-balance.ts): `settleByBalance` is the one atomic,
 *   compare-and-set commit of a `runner:` hold the runner proved from the wallet's finalized token balance. Not sold reopens the
 *   position; sold completes the pending exit with proceeds UNKNOWN (an exit whose proceedsLamports is null, never 0, so no PnL
 *   is derived for that leg). The last such settlement is kept on the position (`settlement`) for readback.
 * Nothing here signs, sends, values or decides; private-exit-triggers.ts decides, the S2-S4 path executes. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS } from "./private-sizing.js";
import { privateExitSnapshotValid, PRIVATE_EXIT_TRIGGERS, type PrivateExitSnapshot, type PrivateExitTrailing,
  type PrivateExitTrigger } from "./private-exit-triggers.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_POSITION_STATES = ["open", "held", "closed"] as const;
export type PrivatePositionState = typeof PRIVATE_POSITION_STATES[number];
/** Open or held positions per agent; closed ones beyond PRIVATE_POSITIONS_MAX_CLOSED are evicted oldest first. */
export const PRIVATE_POSITIONS_MAX_ACTIVE = 64;
export const PRIVATE_POSITIONS_MAX_CLOSED = 64;
/** Evicted entry reservationIds kept to refuse a reopen: the journal's capacity (64 attempts, so at most 64 ids whose buy is still
 * journaled) plus every closed position one burst of evictions can drop before the next forgetEvicted. */
export const PRIVATE_POSITIONS_MAX_EVICTED = 128;
/** Completed exits per position: every ladder level plus the final stop/trailing exit. */
const MAX_EXITS = 20;
export const PRIVATE_POSITIONS_MAX_LEDGER_BYTES = 512 * 1024;
/** Per-position bound: the largest position the parser admits serialises to about 5.9 KiB (16 levels, 20 exits, a 96-char hold
 * reason, every u64 at 20 digits) plus a wallet-balance settlement record (about 0.2 KiB); 64 of them plus the envelope stay far
 * below the ledger cap, leaving room for closed history. */
export const PRIVATE_POSITION_MAX_BYTES = 7 * 1024;
/** The enable-time watermark lists at most one journal's worth of buy attempts. */
export const PRIVATE_POSITIONS_MAX_PRE_ENABLE = 64;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const POSITION_ID = /^pos:[0-9a-f]{32}$/;
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const REASON = /^[a-z0-9_:]{1,96}$/;
const RULE_REVISION = /^brr_[A-Za-z0-9_-]{1,120}$/;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;
const WSOL = "So11111111111111111111111111111111111111112";

/** Owner decision of 15 Nov 2026 ("Çıkışa izin ver", F-M36-D7-B follow-up): the exit-path writes, and only these, are accepted while
 * the wall clock is below the ledger's lastObservedAt (a forward wall-clock step that pinned the mark ahead and was reset, or a
 * genuine backward step). Their time is clamped to lastObservedAt, so updatedAt, every exit time and lastObservedAt stay monotonic
 * and parseSnapshot's invariants hold. Owner decision of 16 Nov 2026 (flip review, wallet-hold class): addOutsideMint is clamped the
 * same way. It only takes a mint off automatic management (restrictive), and it is the first write of a buy's settlement when its
 * proof found an outside credit (S4 R4) and of the owner's close-out, so refusing it kept that buy's wallet held. Every other write
 * (opening a position from a buy, the watermark, the owner's unmanage, evicted-id housekeeping) still refuses clock_rollback. The
 * operation is fixed by each public method below, never by a caller. */
const EXIT_PATH_OPERATIONS = ["recordTrailing", "beginExit", "completeExit", "failExit", "holdLateExit", "settleByBalance"] as const;
const CLAMPED_OPERATIONS: readonly string[] = [...EXIT_PATH_OPERATIONS, "addOutsideMint"];
type LedgerOperation = typeof EXIT_PATH_OPERATIONS[number] | "open" | "recordManagedFrom" | "addOutsideMint" | "unmanageBuy" | "forgetEvicted" | "rebindExits";
const exitPath = (operation: LedgerOperation): boolean => CLAMPED_OPERATIONS.includes(operation);

export const PRIVATE_POSITION_ERRORS = ["invalid_request", "unknown_agent", "state_unavailable", "closing", "clock_rollback", "ledger_full",
  "position_missing", "position_conflict", "position_not_open", "position_evicted", "exit_pending", "exit_missing", "exit_conflict", "trailing_regression",
  "position_not_managed", "position_not_held"] as const;
export type PrivatePositionErrorCode = typeof PRIVATE_POSITION_ERRORS[number];
export class PrivatePositionError extends Error {
  constructor(readonly code: PrivatePositionErrorCode) { super(`Local position ledger ${code}`); this.name = "PrivatePositionError"; }
}
function fail(code: PrivatePositionErrorCode = "invalid_request"): never { throw new PrivatePositionError(code); }

/** The completed buy that opened the position. `planDigest` (64 hex, the buy request's plan digest) and `slippageBps` (the entry
 * plan's, 1..5000) are what every sell assessment of this position names: Balchemy binds an exit to its entry plan. */
export interface PrivatePositionEntry {
  buildDigest: string; reservationId: string; signature: string; units: string; costLamports: string; planDigest: string; slippageBps: number;
}
/** The SDK sell-assessment bound on slippage: the shared execution bound (private-sizing.ts), the same value buy admission
 * enforces, so a buy above it is refused before it is built instead of completing without an openable position. */
export const PRIVATE_POSITION_MAX_SLIPPAGE_BPS = PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS;
export interface PrivatePositionPendingExit { reservationId: string; trigger: PrivateExitTrigger; level: number | null; units: string; createdAt: number }
/** `proceedsLamports` null: the exit was proven sold from the wallet balance, so its proceeds are UNKNOWN (never 0, no PnL). */
export interface PrivatePositionExit { reservationId: string; trigger: PrivateExitTrigger; level: number | null; units: string; proceedsLamports: string | null; completedAt: number }
/** The last `runner:` hold settled from the wallet balance: which pending exit, the proven result, the bounded reason, the hold
 * reason it replaced and when. */
export interface PrivatePositionSettlement { reservationId: string; result: "sold" | "not_sold"; reason: string; heldFor: string; at: number }
/** Owner decision of 21 Nov 2026 (private-exit-rebind.ts): the last owner-confirmed re-bind of this position's exit snapshot to a newly
 * confirmed rule revision: the operation, the revision and its rules digest, and when. Absent until one applied (and in ledgers written
 * before it existed, which therefore parse and are written exactly as before). An older runner, whose closed key set lacks it, fails
 * closed (state_unavailable) only on a ledger that holds one. */
export interface PrivatePositionRebound { operationId: string; revisionId: string; rulesDigest: string; at: number }
export interface PrivatePosition {
  positionId: string; walletAddress: string; tokenMint: string; exit: PrivateExitSnapshot; entry: PrivatePositionEntry;
  /** proceedsLamports: the sum of every exit whose proceeds are known. */
  originalUnits: string; remainingUnits: string; costLamports: string; proceedsLamports: string;
  takeProfitFired: number[]; trailingArmed: boolean; highWaterLamports: string | null;
  pendingExit: PrivatePositionPendingExit | null; exits: PrivatePositionExit[];
  state: PrivatePositionState; holdReason: string | null; createdAt: number; updatedAt: number;
  /** Absent until a wallet-balance settlement applied (and in ledgers written before it existed). */
  settlement?: PrivatePositionSettlement;
  /** Absent until the owner re-bound this position's exits to a newer confirmed revision (rebindExits). */
  rebound?: PrivatePositionRebound;
}
/** The enable-time watermark (see the module comment): the pre-enable completed buys and their output mints (unique).
 * `outsideMints` (SF2, absent while empty, so a ledger without it is written exactly as before): mints whose units in the wallet
 * include an outside credit the runner recorded when it proved a dropped buy did not land (dust). Like the pre-enable mints they are
 * kept for good: the wallet-balance settlement never settles a hold of such a mint (`unmanaged_mint`). An older runner, whose
 * closed key set lacks it, fails closed (state_unavailable) only on a ledger that holds one.
 * `ownerUnmanaged` (owner item 75 of 13 Nov 2026, `runner positions <agent> unmanage <reservation-id>`; absent while empty, so a
 * ledger without it is written byte-identically as before): completed buys whose position could not open that the OWNER took off
 * automatic management by typed confirmation, with their output mint and when. Irreversible (no re-manage). Like a pre-enable buy
 * such a buy is never opened (`open` refuses it in the same snapshot read: position_not_managed), never holds new buys (the exit
 * worker's entryHold) and is no longer retained for its position (privateBuyAwaitingPosition); like the outside mints its mint is
 * kept for good among privateUnmanagedMints, so the wallet-balance settlement never settles a hold of that mint from the balance.
 * At most PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED entries; a further one is refused ledger_full. An older runner, whose closed key set
 * lacks it, fails closed (state_unavailable) only on a ledger that holds one. */
export interface PrivatePositionManagedFrom { recordedAt: number; preEnable: string[]; preEnableMints: string[]; outsideMints?: string[];
  ownerUnmanaged?: PrivatePositionOwnerUnmanaged[] }
/** One completed buy the owner took off automatic management: its entry reservationId, output mint and the time of the write. */
export interface PrivatePositionOwnerUnmanaged { reservationId: string; tokenMint: string; at: number }
/** SF2: outside-credit mints kept on the watermark (bounded; a further one is refused ledger_full, so its buy stays held). */
export const PRIVATE_POSITIONS_MAX_OUTSIDE_MINTS = 64;
/** Owner item 75: owner-unmanaged buys kept on the watermark (bounded; a further one is refused ledger_full and nothing is written). */
export const PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED = 64;
/** Every mint the wallet-balance settlement must never settle from the balance: the pre-enable mints, the outside-credit mints and the
 * mints of owner-unmanaged buys (each once); null while no watermark is recorded. */
export function privateUnmanagedMints(managedFrom: PrivatePositionManagedFrom | null | undefined): string[] | null {
  if (!managedFrom) return null;
  const mints = [...managedFrom.preEnableMints, ...(managedFrom.outsideMints ?? [])];
  for (const item of managedFrom.ownerUnmanaged ?? []) if (!mints.includes(item.tokenMint)) mints.push(item.tokenMint);
  return mints;
}
/** Owner item 75: whether the owner took this completed buy (its entry reservationId) off automatic management. */
export function privateOwnerUnmanaged(managedFrom: PrivatePositionManagedFrom | null | undefined, reservationId: string): boolean {
  return (managedFrom?.ownerUnmanaged ?? []).some((item) => item.reservationId === reservationId);
}
/** One completed buy the journal holds when the watermark is recorded. */
export interface PrivatePositionPreEnableBuy { reservationId: string; tokenMint: string }
export const PRIVATE_POSITION_BALANCE_RESULTS = ["sold", "not_sold"] as const;
export interface PrivatePositionBalanceSettlementInput {
  reservationId: string; result: "sold" | "not_sold"; reason: string;
  /** The proof's view, re-checked inside the commit: the held position's units before the exit, the exit's units and the summed
   * remaining units of every other open position of the same wallet and mint. */
  heldUnits: string; exitUnits: string; otherUnits: string;
}
/** `evicted` is optional on read (ledgers written before it existed) and always written; `managedFrom` is optional on read and
 * written once recorded. */
interface Snapshot { schemaVersion: 1; localProfileId: string; agentId: string; lastObservedAt: number; positions: PrivatePosition[]; evicted: string[];
  managedFrom?: PrivatePositionManagedFrom }
export interface PrivatePositionOpenInput {
  walletAddress: string; tokenMint: string; exit: PrivateExitSnapshot; entry: PrivatePositionEntry;
}

function u64(value: unknown, minimum = 0n): bigint {
  if (typeof value !== "string" || !U64.test(value)) fail();
  const result = BigInt(value); if (result < minimum || result > U64_MAX) fail(); return result;
}
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  const present = optional.filter((key) => Object.hasOwn(fields, key)).length;
  if (Reflect.ownKeys(value).length !== keys.length + present || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function level(value: unknown, exit: PrivateExitSnapshot): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value >= exit.takeProfitLevels.length) fail();
  return value;
}
function trigger(value: unknown): PrivateExitTrigger {
  return PRIVATE_EXIT_TRIGGERS.find((item) => item === value) ?? fail();
}
function parseExit(value: unknown): PrivateExitSnapshot {
  if (!privateExitSnapshotValid(value)) fail();
  const v = value;
  return { stopLossBps: v.stopLossBps, takeProfitLevels: v.takeProfitLevels.map((item) => ({ triggerBps: item.triggerBps, sellBps: item.sellBps })),
    ...(v.trailingActivateBps !== undefined ? { trailingActivateBps: v.trailingActivateBps, trailingStopBps: v.trailingStopBps } : {}) };
}
function parseEntry(value: unknown): PrivatePositionEntry {
  exact(value, ["buildDigest", "reservationId", "signature", "units", "costLamports", "planDigest", "slippageBps"]);
  if (typeof value.buildDigest !== "string" || !HEX.test(value.buildDigest) || typeof value.reservationId !== "string" || !UUID4.test(value.reservationId)
    || typeof value.signature !== "string" || !TX_SIGNATURE.test(value.signature) || typeof value.planDigest !== "string" || !HEX.test(value.planDigest)
    || typeof value.slippageBps !== "number" || !Number.isSafeInteger(value.slippageBps) || value.slippageBps < 1
    || value.slippageBps > PRIVATE_POSITION_MAX_SLIPPAGE_BPS) fail();
  u64(value.units, 1n); u64(value.costLamports, 1n);
  return { buildDigest: value.buildDigest, reservationId: value.reservationId, signature: value.signature, units: value.units as string,
    costLamports: value.costLamports as string, planDigest: value.planDigest, slippageBps: value.slippageBps };
}
function parsePosition(value: unknown, scope: { localProfileId: string; agentId: string }): PrivatePosition {
  exact(value, ["positionId", "walletAddress", "tokenMint", "exit", "entry", "originalUnits", "remainingUnits", "costLamports", "proceedsLamports",
    "takeProfitFired", "trailingArmed", "highWaterLamports", "pendingExit", "exits", "state", "holdReason", "createdAt", "updatedAt"], ["settlement", "rebound"]);
  const v = value;
  const exit = parseExit(v.exit); const entry = parseEntry(v.entry);
  if (v.positionId !== privatePositionId(scope.localProfileId, scope.agentId, entry.buildDigest) || !isSolanaAddress(v.walletAddress)
    || !isSolanaAddress(v.tokenMint) || v.tokenMint === WSOL || v.walletAddress === v.tokenMint
    || !PRIVATE_POSITION_STATES.includes(v.state as PrivatePositionState) || typeof v.trailingArmed !== "boolean"
    || !isTimestamp(v.createdAt) || !isTimestamp(v.updatedAt) || (v.updatedAt as number) < (v.createdAt as number)
    || (v.holdReason !== null && (typeof v.holdReason !== "string" || !REASON.test(v.holdReason)))) fail();
  const original = u64(v.originalUnits, 1n); const remaining = u64(v.remainingUnits); const proceeds = u64(v.proceedsLamports);
  if (v.originalUnits !== entry.units || v.costLamports !== entry.costLamports || remaining > original) fail();
  const highWater = v.highWaterLamports === null ? null : u64(v.highWaterLamports, 1n);
  if (v.trailingArmed !== (highWater !== null) || (v.trailingArmed && exit.trailingActivateBps === undefined)) fail();
  if (!Array.isArray(v.takeProfitFired) || v.takeProfitFired.length > exit.takeProfitLevels.length
    || (v.takeProfitFired as unknown[]).some((index, at) => index !== at)) fail();
  let pending: PrivatePositionPendingExit | null = null;
  if (v.pendingExit !== null) {
    const p = v.pendingExit; exact(p, ["reservationId", "trigger", "level", "units", "createdAt"]);
    if (typeof p.reservationId !== "string" || !UUID4.test(p.reservationId) || !isTimestamp(p.createdAt)) fail();
    pending = { reservationId: p.reservationId, trigger: trigger(p.trigger), level: level(p.level, exit), units: p.units as string, createdAt: p.createdAt as number };
    if (u64(pending.units, 1n) > remaining || (pending.trigger === "take_profit") !== (pending.level !== null)) fail();
  }
  if (!Array.isArray(v.exits) || v.exits.length > MAX_EXITS) fail();
  let sold = 0n; let earned = 0n;
  const exits = (v.exits as unknown[]).map((item): PrivatePositionExit => {
    exact(item, ["reservationId", "trigger", "level", "units", "proceedsLamports", "completedAt"]);
    if (typeof item.reservationId !== "string" || !UUID4.test(item.reservationId) || !isTimestamp(item.completedAt)) fail();
    // null: proceeds unknown (a wallet-balance settlement); never counted, never read as 0.
    const done = { reservationId: item.reservationId, trigger: trigger(item.trigger), level: level(item.level, exit), units: item.units as string,
      proceedsLamports: item.proceedsLamports === null ? null : item.proceedsLamports as string, completedAt: item.completedAt as number };
    sold += u64(done.units, 1n); if (done.proceedsLamports !== null) earned += u64(done.proceedsLamports);
    return done;
  });
  const pendingId = pending?.reservationId;
  if (sold !== original - remaining || earned !== proceeds || new Set(exits.map((item) => item.reservationId)).size !== exits.length
    || (pendingId !== undefined && exits.some((item) => item.reservationId === pendingId))) fail();
  // closed <=> nothing remains and nothing is pending; held always carries a reason and a pending exit.
  if ((v.state === "closed") !== (remaining === 0n) || (v.state === "closed" && pending !== null)
    || (v.state === "held") !== (v.holdReason !== null) || (v.state === "held" && pending === null)) fail();
  let settlement: PrivatePositionSettlement | undefined;
  if (v.settlement !== undefined) {
    const s = v.settlement; exact(s, ["reservationId", "result", "reason", "heldFor", "at"]);
    if (typeof s.reservationId !== "string" || !UUID4.test(s.reservationId) || (s.result !== "sold" && s.result !== "not_sold")
      || typeof s.reason !== "string" || !REASON.test(s.reason) || typeof s.heldFor !== "string" || !REASON.test(s.heldFor) || !s.heldFor.startsWith("runner:")
      || !isTimestamp(s.at) || s.at > (v.updatedAt as number) || pendingId === s.reservationId) fail();
    const leg = exits.find((item) => item.reservationId === s.reservationId);
    // Sold: exactly that exit was recorded with unknown proceeds. Not sold: that exit was never recorded.
    if (s.result === "sold" ? !leg || leg.proceedsLamports !== null : leg !== undefined) fail();
    settlement = { reservationId: s.reservationId as string, result: s.result as "sold" | "not_sold", reason: s.reason as string,
      heldFor: s.heldFor as string, at: s.at as number };
  }
  let rebound: PrivatePositionRebound | undefined;
  if (v.rebound !== undefined) {
    const r = v.rebound; exact(r, ["operationId", "revisionId", "rulesDigest", "at"]);
    if (typeof r.operationId !== "string" || !UUID4.test(r.operationId) || typeof r.revisionId !== "string" || !RULE_REVISION.test(r.revisionId)
      || typeof r.rulesDigest !== "string" || !HEX.test(r.rulesDigest) || !isTimestamp(r.at) || r.at < (v.createdAt as number) || r.at > (v.updatedAt as number)) fail();
    rebound = { operationId: r.operationId, revisionId: r.revisionId, rulesDigest: r.rulesDigest, at: r.at };
  }
  return { positionId: v.positionId as string, walletAddress: v.walletAddress as string, tokenMint: v.tokenMint as string, exit, entry,
    originalUnits: v.originalUnits as string, remainingUnits: v.remainingUnits as string, costLamports: v.costLamports as string,
    proceedsLamports: v.proceedsLamports as string, takeProfitFired: [...(v.takeProfitFired as number[])], trailingArmed: v.trailingArmed as boolean,
    highWaterLamports: v.highWaterLamports as string | null, pendingExit: pending, exits, state: v.state as PrivatePositionState,
    holdReason: v.holdReason as string | null, createdAt: v.createdAt as number, updatedAt: v.updatedAt as number, ...(settlement ? { settlement } : {}),
    ...(rebound ? { rebound } : {}) };
}
function parseSnapshot(value: unknown, scope: { localProfileId: string; agentId: string }): Snapshot {
  exact(value, ["schemaVersion", "localProfileId", "agentId", "lastObservedAt", "positions"], ["evicted", "managedFrom"]);
  if (value.schemaVersion !== 1 || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId || !isTimestamp(value.lastObservedAt)
    || !Array.isArray(value.positions) || value.positions.length > PRIVATE_POSITIONS_MAX_ACTIVE + PRIVATE_POSITIONS_MAX_CLOSED) fail();
  const positions = (value.positions as unknown[]).map((item) => parsePosition(item, scope));
  if (new Set(positions.map((item) => item.positionId)).size !== positions.length
    || new Set(positions.map((item) => item.entry.reservationId)).size !== positions.length
    || positions.filter((item) => item.state !== "closed").length > PRIVATE_POSITIONS_MAX_ACTIVE
    || positions.some((item) => item.updatedAt > (value.lastObservedAt as number))) fail();
  const evicted = value.evicted === undefined ? [] : value.evicted;
  if (!Array.isArray(evicted) || evicted.length > PRIVATE_POSITIONS_MAX_EVICTED || evicted.some((id) => typeof id !== "string" || !UUID4.test(id))
    || new Set(evicted).size !== evicted.length || positions.some((item) => evicted.includes(item.entry.reservationId))) fail();
  let managedFrom: PrivatePositionManagedFrom | undefined;
  if (value.managedFrom !== undefined) {
    const m = value.managedFrom; exact(m, ["recordedAt", "preEnable", "preEnableMints"], ["outsideMints", "ownerUnmanaged"]);
    const pre = m.preEnable; const mints = m.preEnableMints; const outside = m.outsideMints; const owner = m.ownerUnmanaged;
    if (outside !== undefined && (!Array.isArray(outside) || outside.length < 1 || outside.length > PRIVATE_POSITIONS_MAX_OUTSIDE_MINTS
      || outside.some((mint) => typeof mint !== "string" || !isSolanaAddress(mint) || (Array.isArray(mints) && mints.includes(mint)))
      || new Set(outside).size !== outside.length)) fail();
    if (!isTimestamp(m.recordedAt) || m.recordedAt > (value.lastObservedAt as number) || !Array.isArray(pre) || pre.length > PRIVATE_POSITIONS_MAX_PRE_ENABLE
      || pre.some((id) => typeof id !== "string" || !UUID4.test(id)) || new Set(pre).size !== pre.length
      || positions.some((item) => pre.includes(item.entry.reservationId))
      || !Array.isArray(mints) || mints.length > pre.length || mints.some((mint) => typeof mint !== "string" || !isSolanaAddress(mint))
      || new Set(mints).size !== mints.length) fail();
    let ownerUnmanaged: PrivatePositionOwnerUnmanaged[] | undefined;
    if (owner !== undefined) {
      // Never empty (absent instead), bounded, unique, never a pre-enable buy, never a buy with a position or an evicted one.
      if (!Array.isArray(owner) || owner.length < 1 || owner.length > PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED) fail();
      ownerUnmanaged = (owner as unknown[]).map((item) => {
        exact(item, ["reservationId", "tokenMint", "at"]);
        if (typeof item.reservationId !== "string" || !UUID4.test(item.reservationId) || typeof item.tokenMint !== "string" || !isSolanaAddress(item.tokenMint)
          || item.tokenMint === WSOL || !isTimestamp(item.at) || item.at < (m.recordedAt as number) || item.at > (value.lastObservedAt as number)) fail();
        return { reservationId: item.reservationId as string, tokenMint: item.tokenMint as string, at: item.at as number };
      });
      const ids = ownerUnmanaged.map((item) => item.reservationId);
      if (new Set(ids).size !== ids.length || ids.some((id) => (pre as string[]).includes(id) || (evicted as string[]).includes(id))
        || positions.some((item) => ids.includes(item.entry.reservationId))) fail();
    }
    managedFrom = { recordedAt: m.recordedAt, preEnable: [...(pre as string[])], preEnableMints: [...(mints as string[])],
      ...(outside !== undefined ? { outsideMints: [...(outside as string[])] } : {}), ...(ownerUnmanaged ? { ownerUnmanaged } : {}) };
  }
  return { schemaVersion: 1, localProfileId: scope.localProfileId, agentId: scope.agentId, lastObservedAt: value.lastObservedAt as number, positions,
    evicted: [...(evicted as string[])], ...(managedFrom ? { managedFrom } : {}) };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
/** L5: the snapshot to commit, within the byte cap. Positions changed by this commit (`changed`, by positionId) must each fit their own
 * bound; then the oldest closed positions not changed by this commit are evicted until the whole snapshot fits. Unsettled state
 * (open or held) is never dropped: if it cannot fit, nothing is written (`ledger_full`). The changed set is explicit, not
 * `updatedAt === now`: an exit write clamped to lastObservedAt shares its time with the commit that set the mark. */
function fitLedger(snapshot: Snapshot, changed: ReadonlySet<string>): Snapshot {
  if (snapshot.positions.some((item) => changed.has(item.positionId) && bytes(item) > PRIVATE_POSITION_MAX_BYTES)) fail("ledger_full");
  let size = bytes(snapshot);
  if (size <= PRIVATE_POSITIONS_MAX_LEDGER_BYTES) return snapshot;
  const evictable = snapshot.positions.filter((item) => item.state === "closed" && !changed.has(item.positionId)).sort((a, b) => a.updatedAt - b.updatedAt);
  const evicted = new Set<string>(); const ids: string[] = [];
  for (const item of evictable) {
    if (size <= PRIVATE_POSITIONS_MAX_LEDGER_BYTES) break;
    // Removing one array element drops its bytes and one separating comma; its entry reservationId (and a comma) is recorded.
    evicted.add(item.positionId); ids.push(item.entry.reservationId); size -= bytes(item) + 1; size += bytes(item.entry.reservationId) + 1;
  }
  const positions = snapshot.positions.filter((item) => !evicted.has(item.positionId));
  const fitted = { ...snapshot, positions, evicted: [...snapshot.evicted, ...ids] };
  if (fitted.evicted.length > PRIVATE_POSITIONS_MAX_EVICTED) fail("ledger_full");
  if (bytes(fitted) > PRIVATE_POSITIONS_MAX_LEDGER_BYTES) fail("ledger_full");
  return fitted;
}
/** Owner decision of 21 Nov 2026: why one position's exit snapshot is NOT re-bound to a newly confirmed revision (it keeps its own).
 * `position_closed`, `position_held` (an unresolved sell), `exit_pending` (a sell in flight), `already_current` (it already has exactly
 * these exits), `take_profit_started` (a take-profit level already sold and the new ladder does not start with exactly the levels it
 * fired: the ladder progress cannot be carried over), `trailing_armed` (the trailing stop is armed and the new trailing pair differs:
 * its high-water mark belongs to the old pair). Mint-level reasons (`sell_in_flight`, `buy_in_flight`) are decided by the caller, which
 * reads the journal and the DCA records; `position_changed` (it moved since the owner's preview) by the commit. Never transformed:
 * a position that does not qualify keeps the exit snapshot it was opened with. */
export const PRIVATE_EXIT_REBIND_SKIPS = ["position_closed", "position_held", "exit_pending", "already_current", "take_profit_started",
  "trailing_armed", "sell_in_flight", "buy_in_flight", "position_changed"] as const;
export type PrivateExitRebindSkip = typeof PRIVATE_EXIT_REBIND_SKIPS[number];
/** One canonical form of an exit snapshot (the parser's key order), for equality and digests. */
export function privateExitSnapshotKey(exit: PrivateExitSnapshot): string { return JSON.stringify(parseExit(exit)); }
/** The position-level part of the re-bind decision (see PRIVATE_EXIT_REBIND_SKIPS); null when this position may take `next`. */
export function privateExitRebindRefusal(position: Pick<PrivatePosition, "state" | "pendingExit" | "exit" | "takeProfitFired" | "trailingArmed">,
  next: PrivateExitSnapshot): PrivateExitRebindSkip | null {
  if (position.state === "closed") return "position_closed";
  if (position.state === "held") return "position_held";
  if (position.pendingExit !== null) return "exit_pending";
  const current = parseExit(position.exit); const wanted = parseExit(next);
  if (JSON.stringify(current) === JSON.stringify(wanted)) return "already_current";
  const fired = position.takeProfitFired.length;
  if (fired > 0 && (wanted.takeProfitLevels.length < fired
    || JSON.stringify(current.takeProfitLevels.slice(0, fired)) !== JSON.stringify(wanted.takeProfitLevels.slice(0, fired)))) return "take_profit_started";
  if (position.trailingArmed && (wanted.trailingActivateBps !== current.trailingActivateBps || wanted.trailingStopBps !== current.trailingStopBps)) return "trailing_armed";
  return null;
}
/** One position the owner's confirmed re-bind names, with the exit snapshot the owner saw on it. */
export interface PrivatePositionRebindTarget { positionId: string; expectedExit: PrivateExitSnapshot }
export interface PrivatePositionRebindInput {
  operationId: string; revisionId: string; rulesDigest: string; exit: PrivateExitSnapshot; positions: readonly PrivatePositionRebindTarget[];
}
/** Per named position: `rebound` (this commit, or an earlier one of the same operation: `replayed`), or `skipped` with the reason. */
export type PrivatePositionRebindOutcome = { positionId: string; outcome: "rebound"; replayed: boolean }
  | { positionId: string; outcome: "skipped"; reason: PrivateExitRebindSkip };

/** Deterministic id of the position one completed buy opened. */
export function privatePositionId(localProfileId: string, agentId: string, buildDigest: string): string {
  if (!isId(localProfileId) || !isId(agentId) || typeof buildDigest !== "string" || !HEX.test(buildDigest)) fail();
  return `pos:${createHash("sha256").update(JSON.stringify(["balchemy.local-agent.position.v1", localProfileId, agentId, buildDigest]), "utf8")
    .digest("hex").slice(0, 32)}`;
}
export function privatePositionFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `positions-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}

export interface PrivatePositionLedgerOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this ledger never creates a second lock. */
  assertAvailable(): void;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<Snapshot> };

export class PrivatePositionLedger {
  readonly #options: PrivatePositionLedgerOptions;
  readonly #agentIds: string[];
  readonly #slots = new Map<string, Slot>();
  #closed = false;

  constructor(options: PrivatePositionLedgerOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.assertAvailable !== "function") fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, directory: path.resolve(options.directory), agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Read-only readback; an agent without a ledger file has no positions (and none is created). */
  positions(agentId: string): readonly PrivatePosition[] { return freeze(this.#read(agentId, false)?.positions ?? []); }
  /** Entry reservationIds of evicted positions (never reopened). */
  evicted(agentId: string): readonly string[] { return freeze([...(this.#read(agentId, false)?.evicted ?? [])]); }
  position(agentId: string, positionId: string): PrivatePosition | undefined {
    const found = this.#read(agentId, false)?.positions.find((item) => item.positionId === positionId);
    return found ? freeze(found) : undefined;
  }
  /** The enable-time watermark, or null while none is recorded (no file is created). */
  managedFrom(agentId: string): PrivatePositionManagedFrom | null {
    const found = this.#read(agentId, false)?.managedFrom;
    return found ? freeze({ recordedAt: found.recordedAt, preEnable: [...found.preEnable], preEnableMints: [...found.preEnableMints],
      ...(found.outsideMints ? { outsideMints: [...found.outsideMints] } : {}),
      ...(found.ownerUnmanaged ? { ownerUnmanaged: found.ownerUnmanaged.map((item) => ({ ...item })) } : {}) }) : null;
  }
  /** SF2 (R4, before the spend release of a dropped buy whose proof found an outside credit of its mint): keeps `mint` on the
   * watermark for good. Idempotent (a mint already kept writes nothing). Refuses without a recorded watermark (position_not_managed)
   * and past PRIVATE_POSITIONS_MAX_OUTSIDE_MINTS (ledger_full); nothing is written then. Below the mark it is recorded at the mark
   * (CLAMPED_OPERATIONS). */
  addOutsideMint(agentId: string, mint: string, nowMs: number): PrivatePositionManagedFrom {
    if (typeof mint !== "string" || !isSolanaAddress(mint) || mint === WSOL) fail();
    return this.#mutate<PrivatePositionManagedFrom>(agentId, "addOutsideMint", nowMs, (snapshot) => {
      const current = snapshot.managedFrom;
      if (!current) fail("position_not_managed");
      if (current.preEnableMints.includes(mint) || (current.outsideMints ?? []).includes(mint)) return { next: undefined, result: current };
      const outsideMints = [...(current.outsideMints ?? []), mint];
      if (outsideMints.length > PRIVATE_POSITIONS_MAX_OUTSIDE_MINTS) fail("ledger_full");
      const managedFrom = { ...current, outsideMints };
      return { next: { ...snapshot, managedFrom }, result: managedFrom };
    });
  }
  /** Owner item 75 (`runner positions <agent> unmanage <reservation-id>`, after the recovery's eligibility checks): the one ledger write
   * that takes a completed buy whose position could not open off automatic management for good. Compare-and-set inside this single
   * read-check-write: a watermark is recorded, the buy is not pre-enable, no position (open, held or closed) carries its entry
   * reservationId and it was never evicted; then the reservationId and its mint are appended to `ownerUnmanaged`. Idempotent: the same
   * buy and mint already recorded write nothing; the same buy under another mint is position_conflict. Refusals write nothing:
   * position_not_managed (no watermark, or a pre-enable buy), position_conflict (a position exists), position_evicted, ledger_full
   * (PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED reached). Never touches a position, the spend ledger or the journal. */
  unmanageBuy(agentId: string, buy: { reservationId: string; tokenMint: string }, nowMs: number): { managedFrom: PrivatePositionManagedFrom; replayed: boolean } {
    exact(buy, ["reservationId", "tokenMint"]);
    if (typeof buy.reservationId !== "string" || !UUID4.test(buy.reservationId) || typeof buy.tokenMint !== "string" || !isSolanaAddress(buy.tokenMint)
      || buy.tokenMint === WSOL) fail();
    const { reservationId, tokenMint } = buy;
    return this.#mutate<{ managedFrom: PrivatePositionManagedFrom; replayed: boolean }>(agentId, "unmanageBuy", nowMs, (snapshot, at) => {
      const current = snapshot.managedFrom;
      if (!current || current.preEnable.includes(reservationId)) fail("position_not_managed");
      const prior = (current.ownerUnmanaged ?? []).find((item) => item.reservationId === reservationId);
      if (prior) {
        if (prior.tokenMint !== tokenMint) fail("position_conflict");
        return { next: undefined, result: { managedFrom: current, replayed: true } };
      }
      if (snapshot.positions.some((item) => item.entry.reservationId === reservationId)) fail("position_conflict");
      if (snapshot.evicted.includes(reservationId)) fail("position_evicted");
      const ownerUnmanaged = [...(current.ownerUnmanaged ?? []), { reservationId, tokenMint, at }];
      if (ownerUnmanaged.length > PRIVATE_POSITIONS_MAX_OWNER_UNMANAGED) fail("ledger_full");
      const managedFrom = { ...current, ownerUnmanaged };
      return { next: { ...snapshot, managedFrom }, result: { managedFrom, replayed: false } };
    });
  }
  /** Records the enable-time watermark once: `preEnable` are the completed buy attempts the journal holds right now (the caller
   * reads them synchronously, before any buy can be built under the capability). Ids that already have a position, or were
   * evicted, are dropped (they were managed); the output mints of the rest are kept. Idempotent: once recorded it never changes,
   * and a later call returns it without a write. */
  recordManagedFrom(agentId: string, preEnable: readonly PrivatePositionPreEnableBuy[], nowMs: number): PrivatePositionManagedFrom {
    if (!Array.isArray(preEnable) || preEnable.length > PRIVATE_POSITIONS_MAX_PRE_ENABLE
      || preEnable.some((item) => !isRecord(item) || typeof item.reservationId !== "string" || !UUID4.test(item.reservationId)
        || typeof item.tokenMint !== "string" || !isSolanaAddress(item.tokenMint))
      || new Set(preEnable.map((item) => item.reservationId)).size !== preEnable.length) fail();
    const recorded = this.managedFrom(agentId);
    if (recorded) return recorded;
    return this.#mutate<PrivatePositionManagedFrom>(agentId, "recordManagedFrom", nowMs, (snapshot, at) => {
      if (snapshot.managedFrom) return { next: undefined, result: snapshot.managedFrom };
      const opened = new Set(snapshot.positions.map((item) => item.entry.reservationId));
      const kept = preEnable.filter((item) => !opened.has(item.reservationId) && !snapshot.evicted.includes(item.reservationId));
      const managedFrom = { recordedAt: at, preEnable: kept.map((item) => item.reservationId),
        preEnableMints: [...new Set(kept.map((item) => item.tokenMint))] };
      return { next: { ...snapshot, managedFrom }, result: managedFrom };
    });
  }

  /** Opens the position one completed, runner-proven buy created. Idempotent for the same build digest and facts. */
  open(agentId: string, input: PrivatePositionOpenInput, nowMs: number): { position: PrivatePosition; replayed: boolean } {
    exact(input, ["walletAddress", "tokenMint", "exit", "entry"]);
    const exit = parseExit(input.exit); const entry = parseEntry(input.entry);
    if (!isSolanaAddress(input.walletAddress) || !isSolanaAddress(input.tokenMint) || input.tokenMint === WSOL || input.walletAddress === input.tokenMint) fail();
    const positionId = privatePositionId(this.#options.localProfileId, agentId, entry.buildDigest);
    return this.#mutate<{ position: PrivatePosition; replayed: boolean }>(agentId, "open", nowMs, (snapshot, at) => {
      // An evicted position never reopens, whatever the journal still holds.
      if (snapshot.evicted.includes(entry.reservationId)) fail("position_evicted");
      // A buy completed before automatic exits were enabled is never managed automatically (owner decision of 11 Nov 2026), nor one
      // the owner took off automatic management (owner item 75): checked in this same snapshot read, so a pass that read the journal
      // before the owner's write never opens it afterwards.
      if (snapshot.managedFrom?.preEnable.includes(entry.reservationId) || privateOwnerUnmanaged(snapshot.managedFrom, entry.reservationId)) fail("position_not_managed");
      const prior = snapshot.positions.find((item) => item.positionId === positionId || item.entry.reservationId === entry.reservationId);
      if (prior) {
        if (prior.positionId !== positionId || JSON.stringify(prior.entry) !== JSON.stringify(entry) || prior.walletAddress !== input.walletAddress
          || prior.tokenMint !== input.tokenMint || JSON.stringify(prior.exit) !== JSON.stringify(exit)) fail("position_conflict");
        return { next: undefined, result: { position: prior, replayed: true } };
      }
      let positions = snapshot.positions; let evicted = snapshot.evicted;
      if (positions.filter((item) => item.state !== "closed").length >= PRIVATE_POSITIONS_MAX_ACTIVE) fail("ledger_full");
      const closed = positions.filter((item) => item.state === "closed").sort((a, b) => a.updatedAt - b.updatedAt);
      if (closed.length >= PRIVATE_POSITIONS_MAX_CLOSED) {
        const evict = closed[0]!;
        if (evicted.length >= PRIVATE_POSITIONS_MAX_EVICTED) fail("ledger_full");
        positions = positions.filter((item) => item.positionId !== evict.positionId); evicted = [...evicted, evict.entry.reservationId];
      }
      const position: PrivatePosition = { positionId, walletAddress: input.walletAddress, tokenMint: input.tokenMint, exit, entry,
        originalUnits: entry.units, remainingUnits: entry.units, costLamports: entry.costLamports, proceedsLamports: "0", takeProfitFired: [],
        trailingArmed: false, highWaterLamports: null, pendingExit: null, exits: [], state: "open", holdReason: null, createdAt: at, updatedAt: at };
      return { next: { ...snapshot, positions: [...positions, position], evicted }, result: { position, replayed: false } };
    });
  }

  /** Persists a trailing state the trigger evaluation produced. It only moves forward (armed stays armed, the mark never falls).
   * `evaluatedWith` (the exit worker's): the exit snapshot the evaluation used; a position re-bound to other exits since refuses
   * position_conflict and nothing is written (the next pass evaluates the new snapshot). */
  recordTrailing(agentId: string, positionId: string, trailing: PrivateExitTrailing, nowMs: number, evaluatedWith?: PrivateExitSnapshot): PrivatePosition {
    exact(trailing, ["trailingArmed", "highWaterLamports"]);
    const water = trailing.highWaterLamports === null ? null : u64(trailing.highWaterLamports, 1n);
    if (typeof trailing.trailingArmed !== "boolean" || trailing.trailingArmed !== (water !== null)) fail();
    const evaluated = evaluatedWith === undefined ? undefined : privateExitSnapshotKey(evaluatedWith);
    return this.#change(agentId, "recordTrailing", positionId, nowMs, (position) => {
      if (position.state === "closed") fail("position_not_open");
      if (evaluated !== undefined && JSON.stringify(position.exit) !== evaluated) fail("position_conflict");
      if (position.exit.trailingActivateBps === undefined && trailing.trailingArmed) fail();
      const prior = position.highWaterLamports === null ? null : BigInt(position.highWaterLamports);
      if ((position.trailingArmed && !trailing.trailingArmed) || (prior !== null && water !== null && water < prior)) fail("trailing_regression");
      if (position.trailingArmed === trailing.trailingArmed && position.highWaterLamports === trailing.highWaterLamports) return undefined;
      return { ...position, trailingArmed: trailing.trailingArmed, highWaterLamports: trailing.highWaterLamports };
    });
  }

  /** Records the one exit a trigger asked for. A second trigger while one is pending is exit_pending (duplicate protection). */
  beginExit(agentId: string, positionId: string, pending: Omit<PrivatePositionPendingExit, "createdAt">, nowMs: number): PrivatePosition {
    exact(pending, ["reservationId", "trigger", "level", "units"]);
    if (typeof pending.reservationId !== "string" || !UUID4.test(pending.reservationId)) fail();
    const kind = trigger(pending.trigger); const units = u64(pending.units, 1n);
    return this.#change(agentId, "beginExit", positionId, nowMs, (position, at) => {
      if (position.pendingExit) {
        const same = position.pendingExit.reservationId === pending.reservationId && position.pendingExit.trigger === kind
          && position.pendingExit.level === pending.level && position.pendingExit.units === pending.units;
        if (same) return undefined;
        fail("exit_pending");
      }
      if (position.state !== "open") fail("position_not_open");
      if (position.exits.some((item) => item.reservationId === pending.reservationId)) fail("exit_conflict");
      const remaining = BigInt(position.remainingUnits);
      const index = level(pending.level, position.exit);
      // A ladder exit is always the next unfired level; a stop/trailing exit sells everything that remains.
      if (units > remaining || (kind === "take_profit" ? index !== position.takeProfitFired.length : index !== null || units !== remaining)) fail();
      return { ...position, pendingExit: { reservationId: pending.reservationId, trigger: kind, level: index, units: pending.units, createdAt: at } };
    });
  }

  /** The pending exit completed with proven fills: exactly its units were sold for `proceedsLamports`. Idempotent per reservation. */
  completeExit(agentId: string, positionId: string, reservationId: string, fills: { soldUnits: string; proceedsLamports: string }, nowMs: number): PrivatePosition {
    exact(fills, ["soldUnits", "proceedsLamports"]);
    const sold = u64(fills.soldUnits, 1n); u64(fills.proceedsLamports);
    return this.#change(agentId, "completeExit", positionId, nowMs, (position, at) => {
      const done = position.exits.find((item) => item.reservationId === reservationId);
      if (done) {
        if (done.units !== fills.soldUnits || done.proceedsLamports !== fills.proceedsLamports) fail("exit_conflict");
        return undefined;
      }
      const pending = position.pendingExit;
      if (!pending || pending.reservationId !== reservationId) fail("exit_missing");
      if (sold !== BigInt(pending.units)) fail("exit_conflict");
      const remaining = BigInt(position.remainingUnits) - sold;
      const exits = [...position.exits, { reservationId, trigger: pending.trigger, level: pending.level, units: pending.units,
        proceedsLamports: fills.proceedsLamports, completedAt: at }];
      if (exits.length > MAX_EXITS) fail("ledger_full");
      return { ...position, remainingUnits: remaining.toString(), proceedsLamports: (BigInt(position.proceedsLamports) + BigInt(fills.proceedsLamports)).toString(),
        takeProfitFired: pending.trigger === "take_profit" ? [...position.takeProfitFired, pending.level as number] : position.takeProfitFired,
        pendingExit: null, exits, state: remaining === 0n ? "closed" : "open", holdReason: null };
    });
  }

  /** The pending exit did not complete. A proven negative clears it (the next valuation may trigger again); an unknown outcome
   * holds the position with the exit still pending, so no new trigger can stack a second sell behind an unresolved one. */
  failExit(agentId: string, positionId: string, reservationId: string, outcome: "proven_negative" | "unknown", reason: string, nowMs: number): PrivatePosition {
    if ((outcome !== "proven_negative" && outcome !== "unknown") || typeof reason !== "string" || !REASON.test(reason)) fail();
    return this.#change(agentId, "failExit", positionId, nowMs, (position) => {
      const pending = position.pendingExit;
      if (!pending || pending.reservationId !== reservationId) fail("exit_missing");
      if (outcome === "proven_negative") return { ...position, pendingExit: null, state: "open", holdReason: null };
      if (position.state === "held" && position.holdReason === reason) return undefined;
      return { ...position, state: "held", holdReason: reason };
    });
  }

  /** Final audit part 3 SF-A: Balchemy reported, after the runner had proven on its own RPC that a sell it left unresolved did not land
   * (and its pending exit was cleared as proven_negative), that the sell landed (or that a re-signed copy of it did). That contradicts
   * the proof, so the exit is held for the owner again: one atomic write that records exactly that sell (its reservation and units) as the
   * position's pending exit again, held with the `runner:` reason (the hold table's row then applies, private-position-balance.ts).
   * Only an open position with no pending exit that never completed this reservation and still holds its units; the trigger is not
   * journaled, so it is re-derived as beginExit would admit it (fewer units than remain: the next take-profit level; all of them: a stop).
   * SF-A review finding 2: when the wallet-balance settlement had cleared exactly this exit as "not sold" (the S1 bound's balance path),
   * Balchemy's later landing contradicts that settlement too; its record is dropped from the position in the same write, because a
   * pending exit can never be the reservation of the position's own settlement record (parsePosition) and the hold now decides (only
   * "sold", from the sell's own finalized transaction, or the owner). A "sold" settlement of it is in `exits` and refuses as before.
   * Idempotent: the same exit already held with this reason writes nothing. Anything else refuses and changes nothing. */
  holdLateExit(agentId: string, positionId: string, exit: { reservationId: string; units: string }, reason: string, nowMs: number): PrivatePosition {
    exact(exit, ["reservationId", "units"]);
    if (typeof exit.reservationId !== "string" || !UUID4.test(exit.reservationId) || typeof reason !== "string" || !REASON.test(reason) || !reason.startsWith("runner:")) fail();
    const units = u64(exit.units, 1n);
    return this.#change(agentId, "holdLateExit", positionId, nowMs, (position, at) => {
      if (position.pendingExit?.reservationId === exit.reservationId && position.pendingExit.units === exit.units) {
        if (position.state === "held" && position.holdReason === reason) return undefined;
        fail("exit_conflict");
      }
      if (position.pendingExit) fail("exit_pending");
      if (position.state !== "open") fail("position_not_open");
      if (position.exits.some((item) => item.reservationId === exit.reservationId)) fail("exit_conflict");
      const remaining = BigInt(position.remainingUnits);
      if (units > remaining) fail("exit_conflict");
      const partial = units < remaining;
      const level = partial ? position.takeProfitFired.length : null;
      if (level !== null && level >= position.exit.takeProfitLevels.length) fail("exit_conflict");
      const { settlement, ...rest } = position;
      const superseded = settlement?.reservationId === exit.reservationId;
      if (superseded && settlement.result !== "not_sold") fail("exit_conflict");
      return { ...(superseded ? rest : position), pendingExit: { reservationId: exit.reservationId, trigger: partial ? "take_profit" : "stop_loss", level, units: exit.units,
        createdAt: at }, state: "held", holdReason: reason };
    });
  }

  /** The one atomic commit of a wallet-balance settlement (private-position-balance.ts). Compare-and-set inside this single
   * read-check-write: the position is still held with a `runner:` reason and carries exactly the proven pending exit, its units
   * and the other open units of the same wallet and mint are exactly what the proof used, and no other position of that mint is
   * held or has a pending exit. Not sold: the pending exit clears and the position opens again. Sold: the exit is completed with
   * proceeds UNKNOWN (null). Idempotent: a replay of the applied settlement writes nothing; anything else changes nothing. */
  settleByBalance(agentId: string, positionId: string, input: PrivatePositionBalanceSettlementInput, nowMs: number): PrivatePosition {
    exact(input, ["reservationId", "result", "reason", "heldUnits", "exitUnits", "otherUnits"]);
    if (typeof input.reservationId !== "string" || !UUID4.test(input.reservationId) || !PRIVATE_POSITION_BALANCE_RESULTS.includes(input.result)
      || typeof input.reason !== "string" || !REASON.test(input.reason)) fail();
    const held = u64(input.heldUnits, 1n); const units = u64(input.exitUnits, 1n); const others = u64(input.otherUnits);
    if (units > held) fail();
    if (typeof positionId !== "string" || !POSITION_ID.test(positionId)) fail();
    return this.#mutate(agentId, "settleByBalance", nowMs, (snapshot, at) => {
      const index = snapshot.positions.findIndex((item) => item.positionId === positionId);
      const current = snapshot.positions[index];
      if (!current) fail("position_missing");
      if (current.settlement?.reservationId === input.reservationId) {
        if (current.settlement.result !== input.result) fail("exit_conflict");
        return { next: undefined, result: current };
      }
      const pending = current.pendingExit;
      if (current.state !== "held" || !(current.holdReason ?? "").startsWith("runner:")) fail("position_not_held");
      if (!pending || pending.reservationId !== input.reservationId) fail("exit_missing");
      if (BigInt(pending.units) !== units || BigInt(current.remainingUnits) !== held) fail("exit_conflict");
      const same = snapshot.positions.filter((item) => item.positionId !== positionId && item.state !== "closed"
        && item.walletAddress === current.walletAddress && item.tokenMint === current.tokenMint);
      if (same.some((item) => item.state === "held" || item.pendingExit !== null)
        || same.reduce((sum, item) => sum + BigInt(item.remainingUnits), 0n) !== others) fail("exit_conflict");
      const settlement: PrivatePositionSettlement = { reservationId: input.reservationId, result: input.result, reason: input.reason,
        heldFor: current.holdReason as string, at };
      let updated: PrivatePosition;
      if (input.result === "not_sold") updated = { ...current, pendingExit: null, state: "open", holdReason: null, settlement, updatedAt: at };
      else {
        const remaining = held - units;
        const exits = [...current.exits, { reservationId: pending.reservationId, trigger: pending.trigger, level: pending.level, units: pending.units,
          proceedsLamports: null, completedAt: at }];
        if (exits.length > MAX_EXITS) fail("ledger_full");
        updated = { ...current, remainingUnits: remaining.toString(),
          takeProfitFired: pending.trigger === "take_profit" ? [...current.takeProfitFired, pending.level as number] : current.takeProfitFired,
          pendingExit: null, exits, state: remaining === 0n ? "closed" : "open", holdReason: null, settlement, updatedAt: at };
      }
      const positions = [...snapshot.positions]; positions[index] = updated;
      return { next: { ...snapshot, positions }, result: updated };
    });
  }

  /** Owner decision of 21 Nov 2026 (private-exit-rebind.ts): the one durable commit that re-binds the exit snapshot of the named open
   * positions to a newly confirmed rule revision, after the owner saw each position's old and new exits and typed APPLY <agent>. One
   * read-check-commit for all of them (the ledger is one fsynced snapshot per agent): either every eligible position is re-bound or none
   * is. Inside the commit each named position is re-checked: still the exit snapshot the owner saw (otherwise `position_changed`) and
   * still eligible (privateExitRebindRefusal); only `exit` and the `rebound` record change, so the entry, units, cost, proceeds, ladder
   * progress, trailing state, pending exit and history are untouched. Idempotent on restart: a position already carrying this operation
   * with exactly these exits is `rebound` with `replayed` and nothing is written. Refuses (nothing written) clock_rollback while the clock
   * is below the ledger's mark, and ledger_full past the byte bounds. */
  rebindExits(agentId: string, input: PrivatePositionRebindInput, nowMs: number): PrivatePositionRebindOutcome[] {
    exact(input, ["operationId", "revisionId", "rulesDigest", "exit", "positions"]);
    if (typeof input.operationId !== "string" || !UUID4.test(input.operationId) || typeof input.revisionId !== "string" || !RULE_REVISION.test(input.revisionId)
      || typeof input.rulesDigest !== "string" || !HEX.test(input.rulesDigest) || !Array.isArray(input.positions)
      || input.positions.length > PRIVATE_POSITIONS_MAX_ACTIVE) fail();
    const exit = parseExit(input.exit);
    if (!(exit.stopLossBps > 0)) fail();
    const targets = input.positions.map((item) => {
      exact(item, ["positionId", "expectedExit"]);
      if (typeof item.positionId !== "string" || !POSITION_ID.test(item.positionId)) fail();
      return { positionId: item.positionId as string, expected: privateExitSnapshotKey(item.expectedExit as PrivateExitSnapshot) };
    });
    if (new Set(targets.map((item) => item.positionId)).size !== targets.length) fail();
    const wanted = JSON.stringify(exit);
    const { operationId, revisionId, rulesDigest } = input;
    return this.#mutate<PrivatePositionRebindOutcome[]>(agentId, "rebindExits", nowMs, (snapshot, at) => {
      const positions = [...snapshot.positions]; let changed = false;
      const outcomes = targets.map((target): PrivatePositionRebindOutcome => {
        const index = positions.findIndex((item) => item.positionId === target.positionId);
        const current = positions[index];
        if (!current) return { positionId: target.positionId, outcome: "skipped", reason: "position_changed" };
        if (current.rebound?.operationId === operationId && JSON.stringify(current.exit) === wanted) {
          return { positionId: target.positionId, outcome: "rebound", replayed: true };
        }
        if (JSON.stringify(current.exit) !== target.expected) return { positionId: target.positionId, outcome: "skipped", reason: "position_changed" };
        const refusal = privateExitRebindRefusal(current, exit);
        if (refusal) return { positionId: target.positionId, outcome: "skipped", reason: refusal };
        positions[index] = { ...current, exit: structuredClone(exit), rebound: { operationId, revisionId, rulesDigest, at }, updatedAt: at };
        changed = true;
        return { positionId: target.positionId, outcome: "rebound", replayed: false };
      });
      return { next: changed ? { ...snapshot, positions } : undefined, result: outcomes };
    });
  }

  /** Forgets evicted ids whose buy can no longer be presented (`keep` false: its attempt has left the journal). One commit only
   * when something is forgotten; returns how many were. */
  forgetEvicted(agentId: string, keep: (reservationId: string) => boolean, nowMs: number): number {
    if (typeof keep !== "function") fail();
    return this.#mutate<number>(agentId, "forgetEvicted", nowMs, (snapshot) => {
      const kept = snapshot.evicted.filter((id) => keep(id) !== false);
      if (kept.length === snapshot.evicted.length) return { next: undefined, result: 0 };
      return { next: { ...snapshot, evicted: kept }, result: snapshot.evicted.length - kept.length };
    });
  }

  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Preserve files. */ } }
    this.#slots.clear();
  }

  #change(agentId: string, operation: LedgerOperation, positionId: string, nowMs: number,
    change: (position: PrivatePosition, at: number) => PrivatePosition | undefined): PrivatePosition {
    if (typeof positionId !== "string" || !POSITION_ID.test(positionId)) fail();
    return this.#mutate(agentId, operation, nowMs, (snapshot, at) => {
      const index = snapshot.positions.findIndex((item) => item.positionId === positionId);
      const current = snapshot.positions[index];
      if (!current) fail("position_missing");
      const updated = change(current, at);
      if (!updated) return { next: undefined, result: current };
      const position = { ...updated, updatedAt: at };
      const positions = [...snapshot.positions]; positions[index] = position;
      return { next: { ...snapshot, positions }, result: position };
    });
  }
  /** One read-check-commit. `at` is the time the change records: nowMs, or, for a clamped operation while the wall clock is below
   * lastObservedAt, lastObservedAt itself (CLAMPED_OPERATIONS); any other operation then refuses clock_rollback. */
  #mutate<T>(agentId: string, operation: LedgerOperation, nowMs: number,
    change: (snapshot: Snapshot, at: number) => { next: Snapshot | undefined; result: T }): T {
    if (!isTimestamp(nowMs)) fail();
    const slot = this.#slot(agentId, true);
    if (!slot || slot.kind !== "open") return fail("state_unavailable");
    let snapshot: Snapshot;
    try { snapshot = slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    let at = nowMs;
    if (nowMs < snapshot.lastObservedAt) {
      if (!exitPath(operation)) fail("clock_rollback");
      at = snapshot.lastObservedAt;
    }
    const prior = new Set(snapshot.positions);
    const { next, result } = change(snapshot, at);
    if (next) {
      // Positions this commit changed: every position object the change did not carry over unchanged.
      const changed = new Set(next.positions.filter((item) => !prior.has(item)).map((item) => item.positionId));
      // L5: within the byte cap before any write (settled history compacted first); otherwise ledger_full, nothing written.
      const parsed = parseSnapshot(structuredClone({ ...next, lastObservedAt: at }), { localProfileId: this.#options.localProfileId, agentId });
      const fitted = fitLedger(parsed, changed);
      try { slot.storage.commit(fitted); }
      catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    }
    return freeze(structuredClone(result));
  }
  #read(agentId: string, create: boolean): Snapshot | undefined {
    const slot = this.#slot(agentId, create);
    if (!slot) return undefined;
    if (slot.kind === "held") return fail("state_unavailable");
    try { return slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
  }
  #slot(agentId: string, create: boolean): Slot | undefined {
    if (this.#closed) fail("closing");
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent");
    try { this.#options.assertAvailable(); } catch { return fail("state_unavailable"); }
    const current = this.#slots.get(agentId);
    if (current) return current;
    const files = privatePositionFiles(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#options.directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { if (!create && !exists(files.markerFile) && !exists(files.snapshotFile)) return undefined; }
    catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
    try {
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      const storage = new OwnedJsonSnapshot<Snapshot>({ directory: this.#options.directory, ...files,
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId, kind: "position_ledger" }, maximumBytes: PRIVATE_POSITIONS_MAX_LEDGER_BYTES,
        initial: { schemaVersion: 1, ...scope, lastObservedAt: 0, positions: [], evicted: [] }, assertAvailable: this.#options.assertAvailable,
        decode: (value) => parseSnapshot(value, scope) });
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
  }
}
