/** Owner-local autonomous call accounting. No credentials, prices or execution authority. */
import { createHash } from "node:crypto";
import { isId, isTimestamp } from "./protocol.js";
import type { PrivateOuterPrefilterBinding } from "./private-outer-decision.js";

export const DEFAULT_AUTONOMOUS_DAILY_CALL_LIMIT = 200;
export const MAX_AUTONOMOUS_DAILY_CALL_LIMIT = 2000;
export const AUTONOMOUS_TOKEN_COOLDOWN_MS = 600_000;
export const PRIVATE_AUTONOMY_ERRORS = ["invalid_request", "unknown_agent", "revision_conflict", "operation_conflict",
  "clock_rollback", "unprepared", "daily_call_limit", "token_cooldown", "legacy_usage_unknown", "state_unavailable", "cancelled"] as const;
export type PrivateAutonomyErrorCode = typeof PRIVATE_AUTONOMY_ERRORS[number];
export class PrivateAutonomyError extends Error {
  constructor(readonly code: PrivateAutonomyErrorCode) { super(`Private autonomy ${code}`); this.name = "PrivateAutonomyError"; }
}
export type PrivateAutonomyHoldReason = "daily_call_limit" | "token_cooldown" | "legacy_usage_unknown" | "clock_rollback" | "call_allowance_unavailable";
export interface PrivateAutonomyPolicy {
  revision: number; dailyCallLimit: number; tokenCooldownMs: typeof AUTONOMOUS_TOKEN_COOLDOWN_MS;
}
export interface PrivateAutonomyPolicyInput { operationId: string; expectedRevision: number; dailyCallLimit: number }
export interface PrivateAutonomyStatus {
  agentId: string; policy: PrivateAutonomyPolicy; state: "unprepared" | "ready" | "held";
  utcDay: string; reservedCalls: number | null; remainingCalls: number | null;
  legacyHoldUntilMs: number | null;
  reason?: Exclude<PrivateAutonomyHoldReason, "token_cooldown">;
}
export type PrivateAutonomyCheck = { allowed: true; policyRevision: number }
  | { allowed: false; reason: PrivateAutonomyHoldReason; retryAtMs?: number };
export interface PrivateSignalCallReservation {
  version: 1; reservationId: string; reservedAt: number; utcDay: string;
  policyRevision: number; dailyCallLimit: number; admissionDigest: string;
}
export interface PrivateAutonomyReservationInput {
  policyRevision: number; admission: PrivateOuterPrefilterBinding; nowMs: number;
}
function fail(code: PrivateAutonomyErrorCode = "invalid_request"): never { throw new PrivateAutonomyError(code); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(descriptors, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(descriptors).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function revision(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function limit(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_AUTONOMOUS_DAILY_CALL_LIMIT; }
export function privateAutonomyUtcDay(nowMs: number): string {
  if (!isTimestamp(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) fail();
  const result = new Date(nowMs).toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) fail(); return result;
}
export function nextPrivateAutonomyUtcDay(nowMs: number): number {
  const day = privateAutonomyUtcDay(nowMs); const next = Date.parse(`${day}T00:00:00.000Z`) + 86_400_000;
  privateAutonomyUtcDay(next); return next;
}
export function parsePrivateAutonomyPolicyInput(value: unknown): PrivateAutonomyPolicyInput {
  exact(value, ["operationId", "expectedRevision", "dailyCallLimit"]);
  if (!isId(value.operationId) || !revision(value.expectedRevision) || !limit(value.dailyCallLimit)) fail();
  return Object.freeze({ operationId: value.operationId, expectedRevision: value.expectedRevision, dailyCallLimit: value.dailyCallLimit });
}
export function parsePrivateAutonomyPolicy(value: unknown): PrivateAutonomyPolicy {
  exact(value, ["revision", "dailyCallLimit", "tokenCooldownMs"]);
  if (!revision(value.revision) || !limit(value.dailyCallLimit) || value.tokenCooldownMs !== AUTONOMOUS_TOKEN_COOLDOWN_MS) fail();
  return Object.freeze({ revision: value.revision, dailyCallLimit: value.dailyCallLimit, tokenCooldownMs: AUTONOMOUS_TOKEN_COOLDOWN_MS });
}
export function privateSignalCallId(localProfileId: string, agentId: string, jobId: string): string {
  if (![localProfileId, agentId, jobId].every(isId)) fail();
  return `llmc_${createHash("sha256").update(JSON.stringify(["balchemy.private-autonomous-call.v1", localProfileId, agentId, jobId])).digest("hex")}`;
}
export function privateSignalAdmissionDigest(binding: PrivateOuterPrefilterBinding): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`;
}
export function parsePrivateSignalCallReservation(value: unknown, scope: { localProfileId: string; agentId: string; jobId: string }): PrivateSignalCallReservation {
  exact(value, ["version", "reservationId", "reservedAt", "utcDay", "policyRevision", "dailyCallLimit", "admissionDigest"]);
  if (value.version !== 1 || value.reservationId !== privateSignalCallId(scope.localProfileId, scope.agentId, scope.jobId)
    || !isTimestamp(value.reservedAt) || value.utcDay !== privateAutonomyUtcDay(value.reservedAt)
    || !revision(value.policyRevision) || !limit(value.dailyCallLimit)
    || typeof value.admissionDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.admissionDigest)) fail();
  return Object.freeze({ version: 1, reservationId: value.reservationId as string, reservedAt: value.reservedAt,
    utcDay: value.utcDay as string, policyRevision: value.policyRevision, dailyCallLimit: value.dailyCallLimit, admissionDigest: value.admissionDigest });
}
export function parsePrivateAutonomyStatus(value: unknown): PrivateAutonomyStatus {
  exact(value, ["agentId", "policy", "state", "utcDay", "reservedCalls", "remainingCalls", "legacyHoldUntilMs"], ["reason"]);
  if (!isId(value.agentId) || typeof value.utcDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.utcDay)
    || privateAutonomyUtcDay(Date.parse(`${value.utcDay}T00:00:00.000Z`)) !== value.utcDay
    || (value.state !== "unprepared" && value.state !== "ready" && value.state !== "held")
    || (value.legacyHoldUntilMs !== null && !isTimestamp(value.legacyHoldUntilMs))) fail();
  const policy = parsePrivateAutonomyPolicy(value.policy);
  if (value.reservedCalls !== null && (!revision(value.reservedCalls) || value.reservedCalls > MAX_AUTONOMOUS_DAILY_CALL_LIMIT)) fail();
  if (value.remainingCalls !== null && (!revision(value.remainingCalls) || value.remainingCalls > policy.dailyCallLimit)) fail();
  if (value.state === "ready") {
    if (Object.hasOwn(value, "reason") || value.reservedCalls === null || value.remainingCalls !== Math.max(0, policy.dailyCallLimit - Number(value.reservedCalls))) fail();
  } else {
    if (typeof value.reason !== "string" || !["daily_call_limit", "legacy_usage_unknown", "clock_rollback", "call_allowance_unavailable"].includes(value.reason)) fail();
    if (value.state === "unprepared" && (value.reason !== "call_allowance_unavailable" || value.reservedCalls !== null || value.remainingCalls !== null)) fail();
    if (["legacy_usage_unknown", "clock_rollback", "call_allowance_unavailable"].includes(value.reason) && (value.reservedCalls !== null || value.remainingCalls !== null)) fail();
    if (value.reason === "daily_call_limit" && (value.reservedCalls === null || Number(value.reservedCalls) < policy.dailyCallLimit || value.remainingCalls !== 0)) fail();
  }
  return structuredClone({ ...value, policy }) as unknown as PrivateAutonomyStatus;
}

/** Compact durable policy/activation metadata; usage facts remain in immutable jobs. */
export interface PrivateAutonomyCheckpoint {
  agentId: string; policy: PrivateAutonomyPolicy; clockHighWaterMs: number; totalReservationCount: number;
  activation: { at: number; throughOrdinal: number; legacyHoldUntilMs: number | null } | null;
  lastPolicyChange: PrivateAutonomyPolicyInput | null;
}
export function initialPrivateAutonomyCheckpoint(agentId: string, nowMs: number): PrivateAutonomyCheckpoint {
  if (!isId(agentId)) fail(); privateAutonomyUtcDay(nowMs);
  return { agentId, policy: { revision: 0, dailyCallLimit: DEFAULT_AUTONOMOUS_DAILY_CALL_LIMIT, tokenCooldownMs: AUTONOMOUS_TOKEN_COOLDOWN_MS },
    clockHighWaterMs: nowMs, totalReservationCount: 0, activation: null, lastPolicyChange: null };
}
export function parsePrivateAutonomyCheckpoint(value: unknown, nextOrdinal: number): PrivateAutonomyCheckpoint {
  exact(value, ["agentId", "policy", "clockHighWaterMs", "totalReservationCount", "activation", "lastPolicyChange"]);
  if (!isId(value.agentId) || !isTimestamp(value.clockHighWaterMs) || !revision(value.totalReservationCount)) fail(); privateAutonomyUtcDay(value.clockHighWaterMs);
  const policy = parsePrivateAutonomyPolicy(value.policy);
  let activation: PrivateAutonomyCheckpoint["activation"] = null;
  if (value.activation !== null) {
    exact(value.activation, ["at", "throughOrdinal", "legacyHoldUntilMs"]);
    const a = value.activation;
    if (!isTimestamp(a.at) || a.at > value.clockHighWaterMs || !revision(a.throughOrdinal) || a.throughOrdinal >= nextOrdinal
      || (a.legacyHoldUntilMs !== null && (!isTimestamp(a.legacyHoldUntilMs) || a.legacyHoldUntilMs <= a.at))) fail();
    activation = { at: a.at, throughOrdinal: a.throughOrdinal, legacyHoldUntilMs: a.legacyHoldUntilMs as number | null };
  }
  if (value.activation === null && value.totalReservationCount !== 0) fail();
  const lastPolicyChange = value.lastPolicyChange === null ? null : parsePrivateAutonomyPolicyInput(value.lastPolicyChange);
  if (lastPolicyChange ? policy.revision !== lastPolicyChange.expectedRevision + 1 || policy.dailyCallLimit !== lastPolicyChange.dailyCallLimit
    : policy.revision !== 0 || policy.dailyCallLimit !== DEFAULT_AUTONOMOUS_DAILY_CALL_LIMIT) fail();
  return { agentId: value.agentId, policy, clockHighWaterMs: value.clockHighWaterMs, totalReservationCount: value.totalReservationCount, activation, lastPolicyChange };
}

/** Bounded current-day/window projection. Rebuilt from validated history at open;
 * only a newly committed reservation may be added during normal operation. */
export class PrivateAutonomyCounter {
  private day: string;
  private count = 0;
  private total = 0;
  get totalReservationCount(): number { return this.total; }
  private lastObservedMs: number;
  private readonly tokens = new Map<string, number>();
  private readonly ids = new Set<string>();
  constructor(readonly agentId: string, nowMs: number, highWaterMs: number) {
    this.day = privateAutonomyUtcDay(Math.max(nowMs, highWaterMs)); this.lastObservedMs = highWaterMs;
  }
  include(chain: "solana" | "base", assetId: string, reservation: PrivateSignalCallReservation, nowMs: number): void {
    if (!Number.isSafeInteger(this.total + 1)) fail("state_unavailable"); this.total += 1;
    if (reservation.utcDay > this.day) fail("state_unavailable");
    if (reservation.utcDay === this.day) {
      if (this.ids.has(reservation.reservationId)) fail("state_unavailable");
      this.ids.add(reservation.reservationId); this.count += 1;
      if (this.count > MAX_AUTONOMOUS_DAILY_CALL_LIMIT) fail("state_unavailable");
    }
    if (reservation.reservedAt + AUTONOMOUS_TOKEN_COOLDOWN_MS > nowMs) {
      const key = `${chain}:${assetId}`;
      this.tokens.set(key, Math.max(this.tokens.get(key) ?? 0, reservation.reservedAt + AUTONOMOUS_TOKEN_COOLDOWN_MS));
      // At most two UTC days can overlap the fixed ten-minute window.
      if (this.tokens.size > MAX_AUTONOMOUS_DAILY_CALL_LIMIT * 2) fail("state_unavailable");
    }
  }
  status(checkpoint: PrivateAutonomyCheckpoint, nowMs: number): PrivateAutonomyStatus {
    if (this.total !== checkpoint.totalReservationCount) fail("state_unavailable");
    const utcDay = privateAutonomyUtcDay(nowMs);
    const common = { agentId: this.agentId, policy: checkpoint.policy, utcDay,
      legacyHoldUntilMs: checkpoint.activation?.legacyHoldUntilMs ?? null };
    if (nowMs < Math.max(this.lastObservedMs, checkpoint.clockHighWaterMs)) return { ...common, state: "held", reason: "clock_rollback", reservedCalls: null, remainingCalls: null };
    this.lastObservedMs = nowMs;
    if (utcDay > this.day) { this.day = utcDay; this.count = 0; this.ids.clear(); }
    if (utcDay !== this.day) fail("clock_rollback");
    for (const [key, until] of this.tokens) if (until <= nowMs) this.tokens.delete(key);
    if (common.legacyHoldUntilMs !== null && nowMs < common.legacyHoldUntilMs) return { ...common, state: "held", reason: "legacy_usage_unknown", reservedCalls: null, remainingCalls: null };
    const remainingCalls = Math.max(0, checkpoint.policy.dailyCallLimit - this.count);
    return { ...common, state: remainingCalls === 0 ? "held" : "ready", reservedCalls: this.count, remainingCalls,
      ...(remainingCalls === 0 ? { reason: "daily_call_limit" as const } : {}) };
  }
  check(checkpoint: PrivateAutonomyCheckpoint, chain: "solana" | "base", assetId: string, nowMs: number): PrivateAutonomyCheck {
    const status = this.status(checkpoint, nowMs);
    if (status.state !== "ready") return { allowed: false, reason: status.reason ?? "call_allowance_unavailable",
      ...(status.reason === "daily_call_limit" ? { retryAtMs: nextPrivateAutonomyUtcDay(nowMs) }
        : status.reason === "legacy_usage_unknown" && status.legacyHoldUntilMs !== null ? { retryAtMs: status.legacyHoldUntilMs } : {}) };
    const until = this.tokens.get(`${chain}:${assetId}`);
    return until !== undefined && until > nowMs ? { allowed: false, reason: "token_cooldown", retryAtMs: until }
      : { allowed: true, policyRevision: checkpoint.policy.revision };
  }
}

export function unpreparedPrivateAutonomyStatus(agentId: string, nowMs: number): PrivateAutonomyStatus {
  const checkpoint = initialPrivateAutonomyCheckpoint(agentId, nowMs);
  return { agentId, policy: checkpoint.policy, state: "unprepared", utcDay: privateAutonomyUtcDay(nowMs),
    reservedCalls: null, remainingCalls: null, legacyHoldUntilMs: null, reason: "call_allowance_unavailable" };
}
