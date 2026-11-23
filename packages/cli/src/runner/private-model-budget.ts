/** Owner-local daily USD budget for the agent's own AI model API cost, per agent and UTC day, kept in the daemon's private
 * directory. Every model call reserves its conservative estimate before the provider is called and settles once after it:
 * at the provider-reported charge, else at the actual tokens times the table price, else (a failed, aborted or unmetered
 * call) at the full estimate. A reservation left open by a crash counts as spent when the store is next opened.
 * Amounts are integer micro-USD. No credential, prompt or provider payload is stored; this grants no execution authority.
 * The separate autonomous call-count allowance (private-autonomy) stays a second, independent limit.
 * Phase 2 (owner decision D2 of 19 Nov 2026): the record may also hold the published OpenRouter price of the agent's chosen
 * OpenRouter model, captured from OpenRouter's catalog at selection. It applies to that exact model ID only (admission estimate and
 * the settlement fallback); every other model keeps the embedded table or the highest-price rule. Optional, so older records decode. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { nextPrivateAutonomyUtcDay, privateAutonomyUtcDay } from "./private-autonomy.js";
import { formatPrivateModelUsd, PRIVATE_MODEL_PRICES_DATE, type PrivateModelPrice } from "./private-model-prices.js";
import { isPrivateBrainModelId, type PrivateBrainProvider } from "./private-brain-providers.js";
import { addRunnerAgent } from "./agent-roster.js";

/** $5.00 per UTC day until the owner sets a limit. */
export const DEFAULT_MODEL_BUDGET_DAILY_MICRO_USD = 5_000_000;
/** $0.10 .. $1000.00 per UTC day. */
export const MIN_MODEL_BUDGET_DAILY_MICRO_USD = 100_000;
export const MAX_MODEL_BUDGET_DAILY_MICRO_USD = 1_000_000_000;
const MAX_OPEN_RESERVATIONS = 16;
const MAX_CALL_MICRO_USD = 1_000_000_000_000;
const MAX_SPENT_MICRO_USD = 1_000_000_000_000_000;
const MAX_CALLS = 1_000_000_000;
const MAX_RECORD_BYTES = 8 * 1024;
const RESERVATION_ID = /^mbr-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const PRIVATE_MODEL_BUDGET_ERRORS = ["invalid_request", "unknown_agent", "revision_conflict", "operation_conflict",
  "clock_rollback", "model_budget_exhausted", "state_unavailable", "closing"] as const;
export type PrivateModelBudgetErrorCode = typeof PRIVATE_MODEL_BUDGET_ERRORS[number];
export class PrivateModelBudgetError extends Error {
  /** With `model_budget_exhausted`: the daily limit that was reached, for the owner-facing reply. */
  constructor(readonly code: PrivateModelBudgetErrorCode, readonly dailyLimitMicroUsd?: number) {
    super(`Local model budget ${code}`); this.name = "PrivateModelBudgetError";
  }
}
function fail(code: PrivateModelBudgetErrorCode, dailyLimitMicroUsd?: number): never { throw new PrivateModelBudgetError(code, dailyLimitMicroUsd); }

export interface PrivateModelBudgetPolicy { revision: number; dailyLimitMicroUsd: number }
/** Phase 2: the captured catalog price of one OpenRouter model (integer micro-USD per one million tokens). */
export interface PrivateModelCapturedPrice { provider: "openrouter"; model: string; inputMicroUsdPerMillion: number; outputMicroUsdPerMillion: number }
/** $10,000 per million tokens, the same bound the catalog applies. */
export const MAX_CAPTURED_PRICE_MICRO_USD_PER_MILLION = 10_000_000_000;
export interface PrivateModelBudgetPolicyInput { operationId: string; expectedRevision: number; dailyLimitMicroUsd: number }
export interface PrivateModelBudgetStatus {
  agentId: string; policy: PrivateModelBudgetPolicy; state: "ready" | "held";
  /** `model_budget_exhausted` once nothing is left today; `clock_rollback` while the local clock is behind a saved time. */
  reason?: "model_budget_exhausted" | "clock_rollback";
  utcDay: string; resetAt: number;
  spentMicroUsd: number; reservedMicroUsd: number; remainingMicroUsd: number; calls: number;
  priceTableDate: string;
  /** Phase 2: the captured OpenRouter price, when one is stored. */
  modelPrice?: PrivateModelCapturedPrice;
}
export type PrivateModelBudgetCheck = { allowed: true }
  | { allowed: false; reason: "model_budget_exhausted" | "clock_rollback"; dailyLimitMicroUsd: number };

interface Reservation { reservationId: string; reservedAt: number; utcDay: string; estimateMicroUsd: number }
interface BudgetRecord {
  schemaVersion: 1; localProfileId: string; agentId: string;
  policy: PrivateModelBudgetPolicy; lastChange: PrivateModelBudgetPolicyInput | null;
  utcDay: string; spentMicroUsd: number; calls: number; reservations: Reservation[]; clockHighWaterMs: number;
  modelPrice?: PrivateModelCapturedPrice;
}

function exact(value: unknown, keys: readonly string[], code: PrivateModelBudgetErrorCode = "invalid_request", optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(code);
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail(code);
}
function count(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
export function isPrivateModelBudgetLimit(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value)
    && value >= MIN_MODEL_BUDGET_DAILY_MICRO_USD && value <= MAX_MODEL_BUDGET_DAILY_MICRO_USD;
}
function utcDay(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try { return privateAutonomyUtcDay(Date.parse(`${value}T00:00:00.000Z`)) === value; } catch { return false; }
}
export function parsePrivateModelBudgetPolicyInput(value: unknown): PrivateModelBudgetPolicyInput {
  exact(value, ["operationId", "expectedRevision", "dailyLimitMicroUsd"]);
  if (!isId(value.operationId) || !count(value.expectedRevision, Number.MAX_SAFE_INTEGER - 1) || !isPrivateModelBudgetLimit(value.dailyLimitMicroUsd)) fail("invalid_request");
  return Object.freeze({ operationId: value.operationId, expectedRevision: value.expectedRevision, dailyLimitMicroUsd: value.dailyLimitMicroUsd });
}
/** Closed validation of one captured price (exact keys, an OpenRouter model ID, bounded integers). */
export function parsePrivateModelCapturedPrice(value: unknown, code: PrivateModelBudgetErrorCode = "invalid_request"): PrivateModelCapturedPrice {
  exact(value, ["provider", "model", "inputMicroUsdPerMillion", "outputMicroUsdPerMillion"], code);
  if (value.provider !== "openrouter" || !isPrivateBrainModelId(value.model) || !count(value.inputMicroUsdPerMillion, MAX_CAPTURED_PRICE_MICRO_USD_PER_MILLION)
    || !count(value.outputMicroUsdPerMillion, MAX_CAPTURED_PRICE_MICRO_USD_PER_MILLION)) fail(code);
  return Object.freeze({ provider: "openrouter", model: value.model, inputMicroUsdPerMillion: value.inputMicroUsdPerMillion,
    outputMicroUsdPerMillion: value.outputMicroUsdPerMillion });
}
export function parsePrivateModelBudgetStatus(value: unknown): PrivateModelBudgetStatus {
  exact(value, ["agentId", "policy", "state", "utcDay", "resetAt", "spentMicroUsd", "reservedMicroUsd", "remainingMicroUsd", "calls", "priceTableDate"],
    "invalid_request", ["reason", "modelPrice"]);
  const modelPrice = Object.hasOwn(value, "modelPrice") ? parsePrivateModelCapturedPrice(value.modelPrice) : undefined;
  exact(value.policy, ["revision", "dailyLimitMicroUsd"]);
  const policy = value.policy;
  if (!isId(value.agentId) || !count(policy.revision, Number.MAX_SAFE_INTEGER) || !isPrivateModelBudgetLimit(policy.dailyLimitMicroUsd)
    || !utcDay(value.utcDay) || value.resetAt !== Date.parse(`${value.utcDay}T00:00:00.000Z`) + 86_400_000
    || !count(value.spentMicroUsd, MAX_SPENT_MICRO_USD) || !count(value.reservedMicroUsd, MAX_CALL_MICRO_USD * MAX_OPEN_RESERVATIONS)
    || !count(value.remainingMicroUsd, policy.dailyLimitMicroUsd) || !count(value.calls, MAX_CALLS)
    || value.remainingMicroUsd !== Math.max(0, policy.dailyLimitMicroUsd - value.spentMicroUsd - value.reservedMicroUsd)
    || typeof value.priceTableDate !== "string" || !utcDay(value.priceTableDate)) fail("invalid_request");
  if (value.state === "ready") { if (Object.hasOwn(value, "reason") || value.remainingMicroUsd === 0) fail("invalid_request"); }
  else if (value.state === "held") {
    if (value.reason === "model_budget_exhausted") { if (value.remainingMicroUsd !== 0) fail("invalid_request"); }
    else if (value.reason !== "clock_rollback") fail("invalid_request");
  } else fail("invalid_request");
  return Object.freeze({ agentId: value.agentId, policy: Object.freeze({ revision: policy.revision as number, dailyLimitMicroUsd: policy.dailyLimitMicroUsd as number }),
    state: value.state as "ready" | "held", ...(value.state === "held" ? { reason: value.reason as "model_budget_exhausted" | "clock_rollback" } : {}),
    utcDay: value.utcDay as string, resetAt: value.resetAt as number, spentMicroUsd: value.spentMicroUsd as number,
    reservedMicroUsd: value.reservedMicroUsd as number, remainingMicroUsd: value.remainingMicroUsd as number, calls: value.calls as number,
    priceTableDate: value.priceTableDate as string, ...(modelPrice ? { modelPrice } : {}) });
}

function decodeRecord(value: unknown, scope: { localProfileId: string; agentId: string }): BudgetRecord {
  exact(value, ["schemaVersion", "localProfileId", "agentId", "policy", "lastChange", "utcDay", "spentMicroUsd", "calls", "reservations", "clockHighWaterMs"],
    "state_unavailable", ["modelPrice"]);
  const modelPrice = Object.hasOwn(value, "modelPrice") ? parsePrivateModelCapturedPrice(value.modelPrice, "state_unavailable") : undefined;
  exact(value.policy, ["revision", "dailyLimitMicroUsd"], "state_unavailable");
  const policy = value.policy;
  if (value.schemaVersion !== 1 || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId
    || !count(policy.revision, Number.MAX_SAFE_INTEGER) || !isPrivateModelBudgetLimit(policy.dailyLimitMicroUsd)
    || !isTimestamp(value.clockHighWaterMs) || !utcDay(value.utcDay) || value.utcDay > privateAutonomyUtcDay(value.clockHighWaterMs)
    || !count(value.spentMicroUsd, MAX_SPENT_MICRO_USD) || !count(value.calls, MAX_CALLS)
    || !Array.isArray(value.reservations) || value.reservations.length > MAX_OPEN_RESERVATIONS) fail("state_unavailable");
  let lastChange: PrivateModelBudgetPolicyInput | null = null;
  if (value.lastChange !== null) {
    try { lastChange = parsePrivateModelBudgetPolicyInput(value.lastChange); } catch { fail("state_unavailable"); }
  }
  if (lastChange ? policy.revision !== lastChange.expectedRevision + 1 || policy.dailyLimitMicroUsd !== lastChange.dailyLimitMicroUsd
    : policy.revision !== 0 || policy.dailyLimitMicroUsd !== DEFAULT_MODEL_BUDGET_DAILY_MICRO_USD) fail("state_unavailable");
  const ids = new Set<string>();
  const highWaterMs = value.clockHighWaterMs as number;
  const records: unknown[] = value.reservations;
  const reservations = records.map((item: unknown): Reservation => {
    exact(item, ["reservationId", "reservedAt", "utcDay", "estimateMicroUsd"], "state_unavailable");
    if (typeof item.reservationId !== "string" || !RESERVATION_ID.test(item.reservationId) || ids.has(item.reservationId)
      || !isTimestamp(item.reservedAt) || item.reservedAt > highWaterMs
      || item.utcDay !== privateAutonomyUtcDay(item.reservedAt) || !count(item.estimateMicroUsd, MAX_CALL_MICRO_USD)) fail("state_unavailable");
    ids.add(item.reservationId);
    return { reservationId: item.reservationId, reservedAt: item.reservedAt, utcDay: item.utcDay as string, estimateMicroUsd: item.estimateMicroUsd };
  });
  return { schemaVersion: 1, localProfileId: scope.localProfileId, agentId: scope.agentId,
    policy: { revision: policy.revision as number, dailyLimitMicroUsd: policy.dailyLimitMicroUsd as number }, lastChange,
    utcDay: value.utcDay as string, spentMicroUsd: value.spentMicroUsd as number, calls: value.calls as number, reservations,
    clockHighWaterMs: value.clockHighWaterMs as number, ...(modelPrice ? { modelPrice: { ...modelPrice } } : {}) };
}
export function privateModelBudgetFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `model-budget-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
function initialRecord(localProfileId: string, agentId: string, nowMs: number): BudgetRecord {
  return { schemaVersion: 1, localProfileId, agentId, policy: { revision: 0, dailyLimitMicroUsd: DEFAULT_MODEL_BUDGET_DAILY_MICRO_USD },
    lastChange: null, utcDay: privateAutonomyUtcDay(nowMs), spentMicroUsd: 0, calls: 0, reservations: [], clockHighWaterMs: nowMs };
}
/** The record as of `nowMs`: a later UTC day starts at zero spend. Open reservations keep their own day. */
function rolled(record: BudgetRecord, nowMs: number): BudgetRecord {
  const day = privateAutonomyUtcDay(nowMs);
  return day > record.utcDay ? { ...record, utcDay: day, spentMicroUsd: 0, calls: 0 } : record;
}
function reserved(record: BudgetRecord): number {
  return record.reservations.reduce((sum, item) => sum + (item.utcDay === record.utcDay ? item.estimateMicroUsd : 0), 0);
}
function view(record: BudgetRecord, nowMs: number): PrivateModelBudgetStatus {
  const rollback = nowMs < record.clockHighWaterMs;
  const current = rollback ? record : rolled(record, nowMs);
  const held = reserved(current);
  const remainingMicroUsd = Math.max(0, current.policy.dailyLimitMicroUsd - current.spentMicroUsd - held);
  return parsePrivateModelBudgetStatus({ agentId: current.agentId, policy: { ...current.policy },
    state: rollback || remainingMicroUsd === 0 ? "held" : "ready",
    ...(rollback ? { reason: "clock_rollback" } : remainingMicroUsd === 0 ? { reason: "model_budget_exhausted" } : {}),
    utcDay: current.utcDay, resetAt: nextPrivateAutonomyUtcDay(Date.parse(`${current.utcDay}T00:00:00.000Z`)),
    spentMicroUsd: current.spentMicroUsd, reservedMicroUsd: held, remainingMicroUsd, calls: current.calls,
    priceTableDate: PRIVATE_MODEL_PRICES_DATE, ...(current.modelPrice ? { modelPrice: { ...current.modelPrice } } : {}) });
}

export interface PrivateModelBudgetOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this store never creates a second lock. */
  assertAvailable(): void;
  now?(): number;
}
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<BudgetRecord> };

export class PrivateModelBudget {
  readonly #options: PrivateModelBudgetOptions;
  readonly #agentIds: string[];
  readonly #directory: string;
  readonly #slots = new Map<string, Slot>();
  #closed = false;

  constructor(options: PrivateModelBudgetOptions) {
    if (!isRecord(options) || !isId(options.localProfileId) || !Array.isArray(options.agentIds) || options.agentIds.length > 64
      || options.agentIds.some((id) => !isId(id)) || new Set(options.agentIds).size !== options.agentIds.length
      || typeof options.assertAvailable !== "function" || typeof options.directory !== "string" || !path.isAbsolute(options.directory)
      || (options.now !== undefined && typeof options.now !== "function")) fail("invalid_request");
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds };
    this.#directory = path.resolve(options.directory);
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Read-only: an agent that never made a metered call or set a limit has no file and shows the default. */
  status(agentId: string): PrivateModelBudgetStatus {
    this.#available(agentId); const now = this.#now();
    return view(this.#read(agentId) ?? initialRecord(this.#options.localProfileId, agentId, now), now);
  }

  /** Read-only admission check of one estimate, for a caller that wants to hold work before any other side effect. */
  check(agentId: string, estimateMicroUsd: number): PrivateModelBudgetCheck {
    this.#available(agentId);
    if (!count(estimateMicroUsd, MAX_CALL_MICRO_USD)) fail("invalid_request");
    const now = this.#now();
    const record = this.#read(agentId) ?? initialRecord(this.#options.localProfileId, agentId, now);
    if (now < record.clockHighWaterMs) return { allowed: false, reason: "clock_rollback", dailyLimitMicroUsd: record.policy.dailyLimitMicroUsd };
    const current = rolled(record, now);
    return current.spentMicroUsd + reserved(current) + estimateMicroUsd > current.policy.dailyLimitMicroUsd
      ? { allowed: false, reason: "model_budget_exhausted", dailyLimitMicroUsd: current.policy.dailyLimitMicroUsd } : { allowed: true };
  }

  /** Durably reserves the estimate before the provider call, or refuses without any provider call. */
  reserve(agentId: string, estimateMicroUsd: number): string {
    const check = this.check(agentId, estimateMicroUsd);
    if (!check.allowed) fail(check.reason, check.dailyLimitMicroUsd);
    const now = this.#now();
    const record = rolled(this.#read(agentId) ?? initialRecord(this.#options.localProfileId, agentId, now), now);
    if (record.reservations.length >= MAX_OPEN_RESERVATIONS) fail("state_unavailable");
    const reservationId = `mbr-${randomUUID()}`;
    this.#write(agentId, { ...record, clockHighWaterMs: Math.max(record.clockHighWaterMs, now),
      reservations: [...record.reservations, { reservationId, reservedAt: now, utcDay: privateAutonomyUtcDay(now), estimateMicroUsd }] });
    return reservationId;
  }

  /** Exactly once per reservation. The amount counts on the reservation's own UTC day; a later day has started at zero. */
  settle(agentId: string, reservationId: string, actualMicroUsd: number): void {
    this.#available(agentId);
    if (typeof reservationId !== "string" || !RESERVATION_ID.test(reservationId) || !count(actualMicroUsd, MAX_CALL_MICRO_USD)) fail("invalid_request");
    const stored = this.#read(agentId);
    const item = stored?.reservations.find((entry) => entry.reservationId === reservationId);
    if (!stored || !item) fail("invalid_request");
    const now = this.#now();
    // A clock behind the saved time never discards spend: the record stays on its own day.
    const record = now < stored.clockHighWaterMs ? stored : rolled(stored, now);
    const sameDay = item.utcDay === record.utcDay;
    const spentMicroUsd = sameDay ? record.spentMicroUsd + actualMicroUsd : record.spentMicroUsd;
    if (!count(spentMicroUsd, MAX_SPENT_MICRO_USD) || !count(record.calls + 1, MAX_CALLS)) fail("state_unavailable");
    this.#write(agentId, { ...record, spentMicroUsd, calls: sameDay ? record.calls + 1 : record.calls,
      clockHighWaterMs: Math.max(record.clockHighWaterMs, now),
      reservations: record.reservations.filter((entry) => entry.reservationId !== reservationId) });
  }

  /** Compare-and-set by revision; an identical replay of the last change is acknowledged without a write.
   * Lowering below today's spend is allowed and holds further calls until the next UTC day. */
  setPolicy(agentId: string, input: unknown): { status: PrivateModelBudgetStatus; replayed: boolean } {
    this.#available(agentId);
    const request = parsePrivateModelBudgetPolicyInput(input);
    const current = this.#read(agentId);
    const now = this.#now();
    if (current?.lastChange?.operationId === request.operationId) {
      if (current.lastChange.expectedRevision !== request.expectedRevision || current.lastChange.dailyLimitMicroUsd !== request.dailyLimitMicroUsd) fail("operation_conflict");
      return { status: view(current, now), replayed: true };
    }
    if ((current?.policy.revision ?? 0) !== request.expectedRevision) fail("revision_conflict");
    const base = current ?? initialRecord(this.#options.localProfileId, agentId, now);
    if (now < base.clockHighWaterMs) fail("clock_rollback");
    const next: BudgetRecord = { ...rolled(base, now), policy: { revision: request.expectedRevision + 1, dailyLimitMicroUsd: request.dailyLimitMicroUsd },
      lastChange: request, clockHighWaterMs: now };
    this.#write(agentId, next);
    return { status: view(next, now), replayed: false };
  }

  /** Phase 2: stores the catalog price of the agent's OpenRouter model (replacing an earlier one). Spend, calls and the limit
   * are unchanged. The price counts only for that exact model ID. */
  setModelPrice(agentId: string, input: unknown): PrivateModelBudgetStatus {
    this.#available(agentId);
    const price = parsePrivateModelCapturedPrice(input);
    const now = this.#now();
    const base = this.#read(agentId) ?? initialRecord(this.#options.localProfileId, agentId, now);
    if (now < base.clockHighWaterMs) fail("clock_rollback");
    const next: BudgetRecord = { ...rolled(base, now), modelPrice: { ...price }, clockHighWaterMs: now };
    this.#write(agentId, next);
    return view(next, now);
  }
  /** The captured price of exactly this OpenRouter model, or undefined (every other model uses the table). Never throws: an
   * unreadable record leaves the table price, and admission itself still fails closed on that record. */
  modelPrice(agentId: string, provider: PrivateBrainProvider, model: string): PrivateModelPrice | undefined {
    if (provider !== "openrouter") return undefined;
    try {
      this.#available(agentId);
      const captured = this.#read(agentId)?.modelPrice;
      return captured && captured.model === model
        ? Object.freeze({ input: captured.inputMicroUsdPerMillion, output: captured.outputMicroUsdPerMillion }) : undefined;
    } catch { return undefined; }
  }

  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Closed regardless. */ } }
    this.#slots.clear();
  }

  #now(): number {
    const now = (this.#options.now ?? Date.now)();
    if (!isTimestamp(now)) fail("state_unavailable");
    return now;
  }
  #available(agentId: string): void {
    if (this.#closed) fail("closing");
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent");
    try { this.#options.assertAvailable(); } catch { fail("state_unavailable"); }
  }
  #write(agentId: string, next: BudgetRecord): void {
    const scope = { localProfileId: this.#options.localProfileId, agentId };
    let checked: BudgetRecord;
    try { checked = decodeRecord(structuredClone(next), scope); } catch { return fail("state_unavailable"); }
    const slot = this.#slots.get(agentId);
    if (slot?.kind === "held") fail("state_unavailable");
    try {
      if (slot?.kind === "open") slot.storage.commit(checked);
      else if (this.#open(agentId, checked).kind !== "open") fail("state_unavailable");
    } catch { this.#hold(agentId); fail("state_unavailable"); }
  }
  #read(agentId: string): BudgetRecord | undefined {
    let slot = this.#slots.get(agentId);
    if (!slot) {
      const files = privateModelBudgetFiles(agentId);
      let present: boolean;
      try {
        const exists = (name: string): boolean => {
          try { fs.lstatSync(path.join(this.#directory, name)); return true; }
          catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
        };
        present = exists(files.markerFile) || exists(files.snapshotFile);
      } catch { return fail("state_unavailable"); }
      if (!present) return undefined;
      slot = this.#open(agentId);
    }
    if (slot.kind === "held") fail("state_unavailable");
    try { return slot.storage.read(); } catch { this.#hold(agentId); return fail("state_unavailable"); }
  }
  /** With `initial`, an absent record is created (marker + fsync, then snapshot + fsync + rename). Without it, an existing
   * record is opened; reservations a previous daemon left open (a crash or kill mid-call) are then counted as spent. */
  #open(agentId: string, initial?: BudgetRecord): Slot {
    let storage: OwnedJsonSnapshot<BudgetRecord> | undefined;
    const scope = { localProfileId: this.#options.localProfileId, agentId };
    try {
      storage = new OwnedJsonSnapshot<BudgetRecord>({ directory: this.#directory, ...privateModelBudgetFiles(agentId),
        marker: { schemaVersion: 1, localProfileId: this.#options.localProfileId, agentId, kind: "model_budget" }, maximumBytes: MAX_RECORD_BYTES,
        // An existing record is decoded from disk; `initial` is used only when nothing exists yet.
        initial: initial ?? initialRecord(this.#options.localProfileId, agentId, 0),
        assertAvailable: this.#options.assertAvailable, decode: (value) => decodeRecord(value, scope) });
      if (!initial) {
        const loaded = storage.read();
        if (loaded.reservations.length) {
          let spentMicroUsd = loaded.spentMicroUsd; let calls = loaded.calls;
          for (const item of loaded.reservations) if (item.utcDay === loaded.utcDay) { spentMicroUsd += item.estimateMicroUsd; calls += 1; }
          storage.commit(decodeRecord({ ...loaded, spentMicroUsd, calls, reservations: [] }, scope));
        }
      }
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch {
      try { storage?.close(); } catch { /* Preserve files; no detail leaves this boundary. */ }
      return this.#hold(agentId);
    }
  }
  #hold(agentId: string): Slot {
    const current = this.#slots.get(agentId);
    if (current?.kind === "open") { try { current.storage.close(); } catch { /* Held regardless. */ } }
    const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held;
  }
}

/** The owner-facing chat answer when the budget refused a model call (no provider call was made). */
export function privateModelBudgetReply(agentId: string, error: PrivateModelBudgetError): string {
  if (error.code === "clock_rollback") return "The AI budget is paused because this computer's clock moved backwards. "
    + `It resumes once the clock passes the last saved time. Check it with balchemy runner budget ${agentId}.`;
  const limit = error.dailyLimitMicroUsd === undefined ? "" : ` of ${formatPrivateModelUsd(error.dailyLimitMicroUsd)}`;
  return `Today's AI budget${limit} is used up; it resets at 00:00 UTC. Raise it with balchemy runner budget ${agentId} --daily-usd N.`;
}
