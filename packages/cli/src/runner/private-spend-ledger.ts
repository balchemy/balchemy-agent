/** Owner-local SOL spend ledger (S3; M3.2 S4 schema v2). One fsynced snapshot per agent holds the owner's caps and every
 * reservation; a reservation record is its own journal entry (plan, assessment, request, wallet, amount), created and fsynced in
 * one synchronous commit under the daemon's exclusive writer, so no reservation exists without its journal or the reverse.
 * States: reserved -> committed | released. Caps count reserved + committed at reservation time. Only an explicit terminal
 * transition frees budget: an unknown outcome keeps its reservation, which also blocks its wallet (decision 11: one unfinished
 * swap per wallet), across restarts. A wall clock behind the last write fails closed for every write that creates or widens
 * (reserve, configure); the two writes that settle an existing reservation (release, commit) are recorded at the last write's
 * time instead (F1 of the flip review: a step back must not keep a wallet held). Grants no authority.
 *
 * S4: each cap is a `PrivateCapSetting` (`unset` never answered, `none` the owner's explicit "no limit", or lamports). `unset`
 * refuses every reservation (`limits_missing`); `none` skips only that cap. There is no per-day reservation count any more:
 * settled entries are kept individually for 60 minutes (beyond the 30-minute evidence horizon, so any replay of a
 * reservation id inside it is still refused), then folded into a per-day aggregate at the next reservation. An open
 * (`reserved`) entry is never folded, so F2 and SF2 holds keep blocking new buys on the wallet with or without a cap; nor is a
 * settled entry a non-terminal or released journal attempt still references (the caller's `keep`), so its close-out or settlement
 * still finds it.
 * Schema v1 snapshots are read in memory (v1 caps are two amounts); the next write is v2, which an older runner refuses
 * (it holds the ledger: fail closed). */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { parsePrivateCapBasis, parsePrivateCapChoice, parsePrivateCapSetting, privateCapBasisMatches, privateCapsAnswered,
  privateSpendRemaining, validPrivateCapPair, PRIVATE_SPEND_CAP_MAX_LAMPORTS, type PrivateCapBasis, type PrivateCapChoice,
  type PrivateCapSetting, type PrivateSpendRemaining } from "./private-spend-cap.js";
import { addRunnerAgent } from "./agent-roster.js";

/** Mirrors the backend's hard daily backstop (LOCAL_AGENT_DAILY_CAP_MAX_LAMPORTS, 10 SOL); it applies only to amount caps. */
export const PRIVATE_SPEND_DAILY_CAP_MAX_LAMPORTS = PRIVATE_SPEND_CAP_MAX_LAMPORTS;
/** A settled entry stays individually addressable this long (beyond LOCAL_AGENT_EXECUTION_EVIDENCE_TTL_MS, 30 minutes). */
export const PRIVATE_SPEND_SETTLED_RETENTION_MS = 60 * 60_000;
const MAX_LEDGER_BYTES = 96 * 1024;
const MAX_ENTRIES = 160;
const MAX_AGGREGATES = 4;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const PRIVATE_SPEND_ERRORS = ["invalid_request", "unknown_agent", "limits_missing", "revision_conflict", "per_trade_cap_exceeded",
  "daily_cap_exceeded", "reservation_capacity_exhausted", "wallet_busy", "reservation_conflict", "reservation_released",
  "reservation_committed", "reservation_missing", "clock_rollback", "state_unavailable", "closing"] as const;
export type PrivateSpendErrorCode = typeof PRIVATE_SPEND_ERRORS[number];
export class PrivateSpendLedgerError extends Error {
  constructor(readonly code: PrivateSpendErrorCode) { super(`Local spend ledger ${code}`); this.name = "PrivateSpendLedgerError"; }
}
function fail(code: PrivateSpendErrorCode = "invalid_request"): never { throw new PrivateSpendLedgerError(code); }

/** Owner caps. Revision 0 is "never answered": both caps `unset`, no basis. A saved revision has both caps answered. */
export interface PrivateSpendLimits {
  revision: number; perTrade: PrivateCapSetting; daily: PrivateCapSetting;
  perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null; updatedAt: number;
}
export interface PrivateSpendLimitsInput {
  expectedRevision: number; perTrade: PrivateCapChoice; daily: PrivateCapChoice;
  perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null;
}
export type PrivateSpendState = "reserved" | "committed" | "released";
export interface PrivateSpendReservation {
  reservationId: string; walletAddress: string; utcDay: string; amountLamports: string; state: PrivateSpendState;
  jobId: string; planDigest: string; assessmentDigest: string; requestDigest: string;
  reservedAt: number; settledAt: number | null; reason: string | null;
}
/** Settled entries older than the retention, folded per UTC day (only today's day is kept). */
export interface PrivateSpendDayAggregate { utcDay: string; committedLamports: string; committedCount: number; releasedCount: number }
export interface PrivateSpendReserveInput {
  reservationId: string; walletAddress: string; amountLamports: string;
  jobId: string; planDigest: string; assessmentDigest: string; requestDigest: string;
}
export interface PrivateSpendStatus {
  agentId: string; limits: PrivateSpendLimits; configured: boolean; utcDay: string; spentLamports: string; reservedLamports: string;
  remaining: PrivateSpendRemaining; open: readonly PrivateSpendReservation[];
}
interface Snapshot {
  schemaVersion: 2; localProfileId: string; agentId: string; limits: PrivateSpendLimits;
  /** Highest wall-clock time any write observed; a later write earlier than this is a clock rollback. */
  lastObservedAt: number; reservations: PrivateSpendReservation[]; aggregates: PrivateSpendDayAggregate[];
}
const UNSET_LIMITS: PrivateSpendLimits = Object.freeze({ revision: 0, perTrade: Object.freeze({ kind: "unset" as const }),
  daily: Object.freeze({ kind: "unset" as const }), perTradeBasis: null, dailyBasis: null, updatedAt: 0 });

function u64(value: unknown, minimum = 0n): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) fail();
  const result = BigInt(value); if (result < minimum || result > (1n << 64n) - 1n) fail(); return result;
}
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail();
  return value;
}
export function privateSpendUtcDay(nowMs: number): string {
  if (!isTimestamp(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) fail();
  return new Date(nowMs).toISOString().slice(0, 10);
}
/** The backend idempotency key: one UUIDv4-shaped id per (agent, job, plan, assessment). A retry of the same assessed plan
 * reuses it and gets the same server reservation and unsigned message; a re-assessment is a distinct reservation. */
export function privateSpendReservationId(input: { localProfileId: string; agentId: string; jobId: string; planDigest: string; assessmentDigest: string }): string {
  if (![input.localProfileId, input.agentId, input.jobId].every(isId) || !HEX.test(input.planDigest) || !HEX.test(input.assessmentDigest)) fail();
  const hex = createHash("sha256").update(JSON.stringify(["balchemy.local-agent.spend-reservation.v1", input.localProfileId, input.agentId,
    input.jobId, input.planDigest, input.assessmentDigest]), "utf8").digest("hex");
  const variant = "89ab"[Number.parseInt(hex[16]!, 16) & 3]!;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function cap<T>(read: () => T): T { try { return read(); } catch { return fail(); } }
/** v2 limits: revision 0 <=> both unset (no basis, updatedAt 0); a saved revision has two answered caps that form a valid pair. */
function parseLimits(value: unknown): PrivateSpendLimits {
  exact(value, ["revision", "perTrade", "daily", "perTradeBasis", "dailyBasis", "updatedAt"]);
  const perTrade = cap(() => parsePrivateCapSetting(value.perTrade, { allowUnset: true }));
  const daily = cap(() => parsePrivateCapSetting(value.daily, { allowUnset: true }));
  const perTradeBasis = cap(() => parsePrivateCapBasis(value.perTradeBasis)), dailyBasis = cap(() => parsePrivateCapBasis(value.dailyBasis));
  const revision = count(value.revision);
  if (!isTimestamp(value.updatedAt)) fail();
  if (revision === 0) {
    if (perTrade.kind !== "unset" || daily.kind !== "unset" || perTradeBasis || dailyBasis || value.updatedAt !== 0) fail();
  } else if (!validPrivateCapPair(perTrade, daily) || !privateCapBasisMatches(perTrade, perTradeBasis) || !privateCapBasisMatches(daily, dailyBasis)
    || [perTradeBasis, dailyBasis].some((basis) => basis && basis.observedAt > (value.updatedAt as number))) fail();
  return { revision, perTrade, daily, perTradeBasis, dailyBasis, updatedAt: value.updatedAt };
}
/** v1 limits (null or two amounts) read as v2 in memory. */
function parseLimitsV1(value: unknown): PrivateSpendLimits {
  if (value === null) return UNSET_LIMITS;
  exact(value, ["revision", "perTradeCapLamports", "dailyCapLamports", "updatedAt"]);
  return parseLimits({ revision: value.revision, perTrade: { kind: "lamports", lamports: value.perTradeCapLamports },
    daily: { kind: "lamports", lamports: value.dailyCapLamports }, perTradeBasis: null, dailyBasis: null, updatedAt: value.updatedAt });
}
function parseReservation(value: unknown): PrivateSpendReservation {
  exact(value, ["reservationId", "walletAddress", "utcDay", "amountLamports", "state", "jobId", "planDigest", "assessmentDigest",
    "requestDigest", "reservedAt", "settledAt", "reason"]);
  const v = value;
  u64(v.amountLamports, 1n);
  if (typeof v.reservationId !== "string" || !UUID4.test(v.reservationId) || !isSolanaAddress(v.walletAddress) || !isId(v.jobId)
    || ![v.planDigest, v.assessmentDigest, v.requestDigest].every((item) => typeof item === "string" && HEX.test(item))
    || !isTimestamp(v.reservedAt) || v.utcDay !== privateSpendUtcDay(v.reservedAt)
    || (v.state === "reserved" ? v.settledAt !== null || v.reason !== null
      : (v.state !== "committed" && v.state !== "released") || !isTimestamp(v.settledAt) || v.settledAt < v.reservedAt
        || typeof v.reason !== "string" || !/^[a-z0-9_:]{1,96}$/.test(v.reason))) fail();
  return { reservationId: v.reservationId, walletAddress: v.walletAddress, utcDay: v.utcDay as string, amountLamports: v.amountLamports as string,
    state: v.state as PrivateSpendState, jobId: v.jobId, planDigest: v.planDigest as string, assessmentDigest: v.assessmentDigest as string,
    requestDigest: v.requestDigest as string, reservedAt: v.reservedAt, settledAt: v.settledAt as number | null, reason: v.reason as string | null };
}
function parseAggregate(value: unknown): PrivateSpendDayAggregate {
  exact(value, ["utcDay", "committedLamports", "committedCount", "releasedCount"]);
  u64(value.committedLamports);
  if (typeof value.utcDay !== "string" || !DAY.test(value.utcDay)) fail();
  return { utcDay: value.utcDay, committedLamports: value.committedLamports as string, committedCount: count(value.committedCount),
    releasedCount: count(value.releasedCount) };
}
function parseSnapshot(value: unknown, scope: { localProfileId: string; agentId: string }): Snapshot {
  if (!isRecord(value)) fail();
  const v1 = value.schemaVersion === 1;
  exact(value, v1 ? ["schemaVersion", "localProfileId", "agentId", "limits", "lastObservedAt", "reservations"]
    : ["schemaVersion", "localProfileId", "agentId", "limits", "lastObservedAt", "reservations", "aggregates"]);
  if ((!v1 && value.schemaVersion !== 2) || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId
    || !isTimestamp(value.lastObservedAt) || !Array.isArray(value.reservations) || value.reservations.length > MAX_ENTRIES) fail();
  const limits = v1 ? parseLimitsV1(value.limits) : parseLimits(value.limits);
  const reservations = (value.reservations as unknown[]).map(parseReservation);
  const aggregates = v1 ? [] : (Array.isArray(value.aggregates) && value.aggregates.length <= MAX_AGGREGATES ? value.aggregates : fail()).map(parseAggregate);
  if (new Set(reservations.map((item) => item.reservationId)).size !== reservations.length
    || new Set(aggregates.map((item) => item.utcDay)).size !== aggregates.length
    || reservations.some((item) => item.reservedAt > (value.lastObservedAt as number) || (item.settledAt ?? 0) > (value.lastObservedAt as number))
    || limits.updatedAt > (value.lastObservedAt as number)) fail();
  // At most one unfinished swap per wallet, ever.
  const open = reservations.filter((item) => item.state === "reserved").map((item) => item.walletAddress);
  if (new Set(open).size !== open.length) fail();
  return { schemaVersion: 2, localProfileId: scope.localProfileId, agentId: scope.agentId, limits, lastObservedAt: value.lastObservedAt,
    reservations, aggregates };
}
/** Folds settled entries older than the retention into today's aggregate (earlier days are simply dropped) and drops
 * aggregates of earlier days. A `reserved` entry is never folded, and neither is one in `keep` (C2: a settled reservation a
 * still-open submission attempt references; its owner close-out or buy settlement reads it again). */
function compact(snapshot: Snapshot, nowMs: number, keep: ReadonlySet<string>): Snapshot {
  const day = privateSpendUtcDay(nowMs);
  const today = snapshot.aggregates.find((item) => item.utcDay === day);
  let committed = BigInt(today?.committedLamports ?? "0"), committedCount = today?.committedCount ?? 0, releasedCount = today?.releasedCount ?? 0;
  const kept: PrivateSpendReservation[] = [];
  for (const item of snapshot.reservations) {
    if (item.state === "reserved" || item.settledAt === null || keep.has(item.reservationId) || nowMs - item.settledAt < PRIVATE_SPEND_SETTLED_RETENTION_MS) {
      kept.push(item); continue;
    }
    if (item.utcDay !== day) continue;
    if (item.state === "committed") { committed += BigInt(item.amountLamports); committedCount += 1; } else releasedCount += 1;
  }
  const folded = committedCount + releasedCount > 0;
  return { ...snapshot, reservations: kept,
    aggregates: folded ? [{ utcDay: day, committedLamports: committed.toString(), committedCount, releasedCount }] : [] };
}
function usedToday(snapshot: Snapshot, day: string): { spent: bigint; reserved: bigint } {
  const today = snapshot.reservations.filter((item) => item.utcDay === day);
  const sum = (state: PrivateSpendState): bigint => today.filter((item) => item.state === state).reduce((total, item) => total + BigInt(item.amountLamports), 0n);
  const folded = BigInt(snapshot.aggregates.find((item) => item.utcDay === day)?.committedLamports ?? "0");
  return { spent: sum("committed") + folded, reserved: sum("reserved") };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value;
}
export function privateSpendFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `spend-ledger-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}

export interface PrivateSpendLedgerOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this ledger never creates a second lock. */
  assertAvailable(): void;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<Snapshot> };

export class PrivateSpendLedger {
  readonly #options: PrivateSpendLedgerOptions;
  readonly #agentIds: string[];
  readonly #slots = new Map<string, Slot>();
  #closed = false;

  constructor(options: PrivateSpendLedgerOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.assertAvailable !== "function") fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, directory: path.resolve(options.directory), agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Read-only; an unconfigured agent's status creates no file. Today's use includes folded settled entries. */
  status(agentId: string, nowMs: number): PrivateSpendStatus {
    const day = privateSpendUtcDay(nowMs);
    const snapshot = this.#read(agentId, false);
    const limits = snapshot?.limits ?? UNSET_LIMITS;
    const { spent, reserved } = snapshot ? usedToday(snapshot, day) : { spent: 0n, reserved: 0n };
    return freeze({ agentId, limits: structuredClone(limits), configured: privateCapsAnswered(limits.perTrade, limits.daily), utcDay: day,
      spentLamports: spent.toString(), reservedLamports: reserved.toString(), remaining: privateSpendRemaining(limits.daily, spent + reserved),
      open: (snapshot?.reservations ?? []).filter((item) => item.state === "reserved").map((item) => ({ ...item })) });
  }
  reservation(agentId: string, reservationId: string): PrivateSpendReservation | undefined {
    const found = this.#read(agentId, false)?.reservations.find((item) => item.reservationId === reservationId);
    return found ? freeze({ ...found }) : undefined;
  }

  /** Owner-confirmed caps with a revision CAS (the only cap writer; reached only from the owner's `private_arming limits_set`).
   * Each cap is `none` or an amount, never `unset`; a basis must reproduce its amount. Lowering below today's usage is allowed
   * and simply refuses new reservations. Raising or removing a cap needs the owner's wallet signature once S6 ships. */
  configure(agentId: string, input: PrivateSpendLimitsInput, nowMs: number): PrivateSpendLimits {
    exact(input, ["expectedRevision", "perTrade", "daily", "perTradeBasis", "dailyBasis"]);
    if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail();
    const perTrade = cap(() => parsePrivateCapChoice(input.perTrade)), daily = cap(() => parsePrivateCapChoice(input.daily));
    const perTradeBasis = cap(() => parsePrivateCapBasis(input.perTradeBasis)), dailyBasis = cap(() => parsePrivateCapBasis(input.dailyBasis));
    return this.#mutate(agentId, nowMs, false, (snapshot) => {
      if (snapshot.limits.revision !== input.expectedRevision) fail("revision_conflict");
      const limits = parseLimits({ revision: input.expectedRevision + 1, perTrade, daily, perTradeBasis, dailyBasis, updatedAt: nowMs });
      return { next: { ...snapshot, limits }, result: limits };
    });
  }

  /** Atomic check-and-reserve. Idempotent for the same id and facts while reserved; never re-opens a terminal one. `keep` (C2): the
   * reservation ids compaction must not fold (privateSubmissionKeptReservations of the agent's journal). */
  reserve(agentId: string, input: PrivateSpendReserveInput, nowMs: number, keep: readonly string[] = []): { reservation: PrivateSpendReservation; replayed: boolean } {
    exact(input, ["reservationId", "walletAddress", "amountLamports", "jobId", "planDigest", "assessmentDigest", "requestDigest"]);
    const amount = u64(input.amountLamports, 1n);
    if (typeof input.reservationId !== "string" || !UUID4.test(input.reservationId) || !isSolanaAddress(input.walletAddress) || !isId(input.jobId)
      || ![input.planDigest, input.assessmentDigest, input.requestDigest].every((item) => typeof item === "string" && HEX.test(item))
      || !Array.isArray(keep) || keep.some((id) => typeof id !== "string")) fail();
    const kept = new Set(keep);
    const day = privateSpendUtcDay(nowMs);
    return this.#mutate(agentId, nowMs, false, (snapshot): { next: Snapshot | undefined; result: { reservation: PrivateSpendReservation; replayed: boolean } } => {
      const existing = snapshot.reservations.find((item) => item.reservationId === input.reservationId);
      if (existing) {
        if (existing.walletAddress !== input.walletAddress || existing.amountLamports !== input.amountLamports || existing.jobId !== input.jobId
          || existing.planDigest !== input.planDigest || existing.assessmentDigest !== input.assessmentDigest
          || existing.requestDigest !== input.requestDigest) fail("reservation_conflict");
        if (existing.state === "released") fail("reservation_released");
        if (existing.state === "committed") fail("reservation_committed");
        return { next: undefined, result: { reservation: { ...existing }, replayed: true } };
      }
      const limits = snapshot.limits;
      if (!privateCapsAnswered(limits.perTrade, limits.daily)) fail("limits_missing");
      if (limits.perTrade.kind === "lamports" && amount > BigInt(limits.perTrade.lamports)) fail("per_trade_cap_exceeded");
      if (snapshot.reservations.some((item) => item.state === "reserved" && item.walletAddress === input.walletAddress)) fail("wallet_busy");
      // Compaction replaces the per-day count: only settled entries past the retention fold; open ones never do.
      const compacted = compact(snapshot, nowMs, kept);
      const { spent, reserved } = usedToday(compacted, day);
      if (limits.daily.kind === "lamports" && spent + reserved + amount > BigInt(limits.daily.lamports)) fail("daily_cap_exceeded");
      const reservation: PrivateSpendReservation = { reservationId: input.reservationId, walletAddress: input.walletAddress, utcDay: day,
        amountLamports: amount.toString(), state: "reserved", jobId: input.jobId, planDigest: input.planDigest, assessmentDigest: input.assessmentDigest,
        requestDigest: input.requestDigest, reservedAt: nowMs, settledAt: null, reason: null };
      // The file stays bounded: more than MAX_ENTRIES entries inside one retention window refuses (an integrity bound, not a cap).
      if (compacted.reservations.length + 1 > MAX_ENTRIES) fail("reservation_capacity_exhausted");
      return { next: { ...compacted, reservations: [...compacted.reservations, reservation] }, result: { reservation: { ...reservation }, replayed: false } };
    });
  }
  /** reserved -> released, only for a proven non-spend (no bytes, bytes never signed, or signed bytes the runner proved on its own
   * RPC did not land: S4's buy settlement, SF2 R4; never on Balchemy's word alone). Idempotent; never un-commits. Below the mark it
   * is recorded at the mark (#settle). */
  release(agentId: string, reservationId: string, reason: string, nowMs: number): PrivateSpendReservation {
    return this.#settle(agentId, reservationId, "released", reason, nowMs);
  }
  /** reserved -> committed (S4: a finalized spend). Idempotent; never un-releases. Below the mark it is recorded at the mark (#settle). */
  commit(agentId: string, reservationId: string, reason: string, nowMs: number): PrivateSpendReservation {
    return this.#settle(agentId, reservationId, "committed", reason, nowMs);
  }
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Preserve files. */ } }
    this.#slots.clear();
  }

  /** F1 of the flip review: a settlement only closes a reservation that already exists, so it is recorded even while the wall clock
   * is behind lastObservedAt, at lastObservedAt itself (the pattern of the position ledger's exit path and the intent store's
   * outcome). Its day never moves: the day is the reservation's utcDay, fixed at reserve time; settledAt only starts the retention. */
  #settle(agentId: string, reservationId: string, state: "committed" | "released", reason: string, nowMs: number): PrivateSpendReservation {
    if (typeof reservationId !== "string" || !UUID4.test(reservationId) || typeof reason !== "string" || !/^[a-z0-9_:]{1,96}$/.test(reason)) fail();
    return this.#mutate(agentId, nowMs, true, (snapshot, at) => {
      const index = snapshot.reservations.findIndex((item) => item.reservationId === reservationId);
      const existing = snapshot.reservations[index]; if (!existing) fail("reservation_missing");
      if (existing.state === state) return { next: undefined, result: { ...existing } };
      if (existing.state !== "reserved") fail(existing.state === "committed" ? "reservation_committed" : "reservation_released");
      const settled: PrivateSpendReservation = { ...existing, state, settledAt: at, reason };
      const reservations = [...snapshot.reservations]; reservations[index] = settled;
      return { next: { ...snapshot, reservations }, result: { ...settled } };
    });
  }
  /** One synchronous read-check-commit section at `at`: nowMs, or, when `clampToMark` and the wall clock is below lastObservedAt,
   * lastObservedAt itself (without `clampToMark` that refuses clock_rollback and writes nothing). `next: undefined` writes nothing.
   * Any write failure holds the agent. */
  #mutate<T>(agentId: string, nowMs: number, clampToMark: boolean, change: (snapshot: Snapshot, at: number) => { next: Snapshot | undefined; result: T }): T {
    if (!isTimestamp(nowMs)) fail();
    const slot = this.#slot(agentId, true);
    if (!slot || slot.kind !== "open") return fail("state_unavailable");
    let snapshot: Snapshot;
    try { snapshot = slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    let at = nowMs;
    if (nowMs < snapshot.lastObservedAt) {
      if (!clampToMark) fail("clock_rollback");
      at = snapshot.lastObservedAt;
    }
    const { next, result } = change(snapshot, at);
    if (next) {
      try { slot.storage.commit(parseSnapshot(structuredClone({ ...next, lastObservedAt: at }), { localProfileId: this.#options.localProfileId, agentId })); }
      catch { this.#slots.set(agentId, { kind: "held" }); return fail("state_unavailable"); }
    }
    return freeze(result);
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
    const files = privateSpendFiles(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#options.directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { if (!create && !exists(files.markerFile) && !exists(files.snapshotFile)) return undefined; }
    catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
    try {
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      const storage = new OwnedJsonSnapshot<Snapshot>({ directory: this.#options.directory, ...files,
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId, kind: "spend_ledger" }, maximumBytes: MAX_LEDGER_BYTES,
        initial: { schemaVersion: 2, ...scope, limits: UNSET_LIMITS, lastObservedAt: 0, reservations: [], aggregates: [] }, assertAvailable: this.#options.assertAvailable,
        decode: (value) => parseSnapshot(value, scope) });
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
  }
}
