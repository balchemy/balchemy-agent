/** K1b DCA durable records: one fsynced snapshot per agent (OwnedJsonSnapshot under the daemon's exclusive writer, the same writer
 * discipline as the execution intents: one synchronous read-check-commit per change). A separate file, so an older runner never
 * meets a DCA key in the intent store or the journal (both closed codecs); an older runner simply never opens this file.
 *
 * Campaigns (one per mint, see private-dca.ts): `spentLamports` only ever grows (folded opening buys, then every add once signed);
 * `lastBuy` is the newest buy ever made in the campaign; `endedAt`/`endReason` end it: `stop_loss` or `trailing_stop` for good (never
 * restarted, never evicted), `holding_closed` restartably (a later holding of the mint starts a new campaign).
 *
 * Adds (exactly once): an add record is written `running`, with its fresh UUID v4 reservationId and its digest-bound plan (mint, parent
 * lot, amount, slippage, the confirmed rule head and the exit snapshot taken from it), BEFORE any reservation or network call; it is
 * never rebuilt. A crash leaves it `running`; recovery resolves it from the journal only (an attempt for its reservation: submitted,
 * else refused interrupted; S4 start recovery has already released a never-signed reservation). An ambiguous build or submission is
 * `held` until the journal or the spend ledger proves it. Only one add per agent is `running`, and no add of a mint starts while
 * another add of that mint is unsettled (running, held or submitted without its lot open). A submitted add is retained until its lot
 * opens (`opened`) or its buy is proven not landed (`not_landed`): the exit worker opens the lot from it (its exit snapshot, plan
 * digest and slippage). Capacity makes room only by evicting the oldest settled add (opened, not_landed, refused), never an opened add whose
 * lot the caller still holds (`begin`'s keep set): that record is what keeps the lot from being folded into the campaign as an opening buy
 * (which would count its spend twice). The folded list keeps every buy the caller still presents and drops the oldest others first. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import { privateExitSnapshotValid, type PrivateExitSnapshot } from "./private-exit-triggers.js";
import { PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS } from "./private-sizing.js";
import { privateDcaPlanDigest, PRIVATE_DCA_MAX_LOTS_PER_MINT } from "./private-dca.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_DCA_ADD_STATES = ["running", "submitted", "opened", "not_landed", "refused", "held"] as const;
export type PrivateDcaAddState = typeof PRIVATE_DCA_ADD_STATES[number];
export const PRIVATE_DCA_END_REASONS = ["stop_loss", "trailing_stop", "holding_closed"] as const;
export type PrivateDcaEndReason = typeof PRIVATE_DCA_END_REASONS[number];
/** Ends that stop adds on the mint for good. */
export const PRIVATE_DCA_PROTECTIVE_ENDS: readonly PrivateDcaEndReason[] = ["stop_loss", "trailing_stop"];
export const PRIVATE_DCA_MAX_CAMPAIGNS = 128;
export const PRIVATE_DCA_MAX_ADDS = 128;
/** Opening buys folded into one campaign (bounded; the ledger holds at most 64 active positions). */
const MAX_FOLDED = 64;
const MAX_BYTES = 512 * 1024;
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const REVISION = /^brr_[0-9a-f]{64}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const REASON = /^[a-z0-9_:]{1,96}$/;
const ATTEMPT = /^att:[0-9a-f]{32}$/;

export interface PrivateDcaLastBuy { at: number; costLamports: string; units: string | null; reservationId: string | null }
export interface PrivateDcaCampaign {
  mint: string; startedAt: number; spentLamports: string; lots: number; folded: string[]; lastBuy: PrivateDcaLastBuy;
  endedAt: number | null; endReason: PrivateDcaEndReason | null; updatedAt: number;
}
export interface PrivateDcaAdd {
  reservationId: string; mint: string; walletAddress: string; parentEntryBuildDigest: string; amountLamports: string; slippageBps: number;
  ruleRevisionId: string; rulesDigest: string; exit: PrivateExitSnapshot; trigger: "interval" | "dip"; runtimeVersion: number;
  planDigest: string; state: PrivateDcaAddState; reason: string | null; attemptKey: string | null; createdAt: number; updatedAt: number;
}
export type PrivateDcaAddInput = Omit<PrivateDcaAdd, "state" | "reason" | "attemptKey" | "updatedAt">;
export type PrivateDcaAddChange = { state: "submitted"; attemptKey: string; reason: string | null }
  | { state: "refused" | "held"; reason: string }
  | { state: "opened"; units: string }
  | { state: "not_landed"; reason: string };
/** A buy folded into a campaign: an opening (signal) position of the mint. */
export interface PrivateDcaFoldedBuy { reservationId: string; costLamports: string; units: string; at: number }
export interface PrivateDcaSnapshotView { campaigns: readonly PrivateDcaCampaign[]; adds: readonly PrivateDcaAdd[] }

export const PRIVATE_DCA_STORE_ERRORS = ["invalid_request", "unknown_agent", "add_conflict", "campaign_ended", "campaign_missing", "add_unsettled",
  "add_running", "lot_cap", "capacity_exhausted", "clock_rollback", "state_unavailable", "closing"] as const;
export class PrivateDcaStoreError extends Error {
  constructor(readonly code: typeof PRIVATE_DCA_STORE_ERRORS[number]) { super(`DCA store ${code}`); this.name = "PrivateDcaStoreError"; }
}
function fail(code: PrivateDcaStoreError["code"] = "invalid_request"): never { throw new PrivateDcaStoreError(code); }
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail();
}
function u64(value: unknown): value is string { return typeof value === "string" && U64.test(value) && BigInt(value) <= U64_MAX; }
const nullable = (value: unknown, check: (item: unknown) => boolean): boolean => value === null || check(value);
/** Adds that still own their mint (no other add of the mint may start). */
export function privateDcaAddUnsettled(add: Pick<PrivateDcaAdd, "state">): boolean { return add.state === "running" || add.state === "held" || add.state === "submitted"; }
/** Adds a capacity eviction may drop (an opened add only once its lot is no longer held). */
const evictable = (add: PrivateDcaAdd, keep: ReadonlySet<string>): boolean =>
  (add.state === "opened" && !keep.has(add.reservationId)) || add.state === "not_landed" || add.state === "refused";
/** At most MAX_FOLDED ids: the oldest ids that are not presented now go first, so a buy still held is never dropped and folded again. */
function trimFolded(folded: readonly string[], presented: ReadonlySet<string>): string[] {
  let drop = folded.length - MAX_FOLDED;
  return folded.filter((id) => { if (drop > 0 && !presented.has(id)) { drop -= 1; return false; } return true; }).slice(-MAX_FOLDED);
}
export function privateDcaCampaignProtectiveEnd(campaign: Pick<PrivateDcaCampaign, "endReason"> | undefined): boolean {
  return campaign?.endReason !== undefined && campaign.endReason !== null && PRIVATE_DCA_PROTECTIVE_ENDS.includes(campaign.endReason);
}

function parseLastBuy(value: unknown): PrivateDcaLastBuy {
  exact(value, ["at", "costLamports", "units", "reservationId"]);
  if (!isTimestamp(value.at) || !u64(value.costLamports) || !nullable(value.units, u64)
    || !nullable(value.reservationId, (item) => typeof item === "string" && UUID4.test(item))) fail();
  return { at: value.at, costLamports: value.costLamports, units: value.units as string | null, reservationId: value.reservationId as string | null };
}
function parseCampaign(value: unknown): PrivateDcaCampaign {
  exact(value, ["mint", "startedAt", "spentLamports", "lots", "folded", "lastBuy", "endedAt", "endReason", "updatedAt"]);
  const v = value;
  if (!isSolanaAddress(v.mint) || !isTimestamp(v.startedAt) || !u64(v.spentLamports) || !Number.isSafeInteger(v.lots) || (v.lots as number) < 0
    || (v.lots as number) > PRIVATE_DCA_MAX_LOTS_PER_MINT || !Array.isArray(v.folded) || v.folded.length > MAX_FOLDED
    || v.folded.some((item: unknown) => typeof item !== "string" || !UUID4.test(item)) || new Set(v.folded).size !== v.folded.length
    || !nullable(v.endedAt, isTimestamp) || !nullable(v.endReason, (item) => PRIVATE_DCA_END_REASONS.includes(item as PrivateDcaEndReason))
    || (v.endedAt === null) !== (v.endReason === null) || !isTimestamp(v.updatedAt)) fail();
  return { mint: v.mint as string, startedAt: v.startedAt, spentLamports: v.spentLamports, lots: v.lots as number, folded: [...v.folded as string[]],
    lastBuy: parseLastBuy(v.lastBuy), endedAt: v.endedAt as number | null, endReason: v.endReason as PrivateDcaEndReason | null, updatedAt: v.updatedAt };
}
function parseAdd(value: unknown, scope: { localProfileId: string; agentId: string }): PrivateDcaAdd {
  exact(value, ["reservationId", "mint", "walletAddress", "parentEntryBuildDigest", "amountLamports", "slippageBps", "ruleRevisionId", "rulesDigest",
    "exit", "trigger", "runtimeVersion", "planDigest", "state", "reason", "attemptKey", "createdAt", "updatedAt"]);
  const v = value;
  if (typeof v.reservationId !== "string" || !UUID4.test(v.reservationId) || !isSolanaAddress(v.mint) || !isSolanaAddress(v.walletAddress)
    || typeof v.parentEntryBuildDigest !== "string" || !HEX.test(v.parentEntryBuildDigest) || !u64(v.amountLamports) || BigInt(v.amountLamports) <= 0n
    || !Number.isSafeInteger(v.slippageBps) || (v.slippageBps as number) < 1 || (v.slippageBps as number) > PRIVATE_EXECUTION_MAX_SLIPPAGE_BPS
    || typeof v.ruleRevisionId !== "string" || !REVISION.test(v.ruleRevisionId) || typeof v.rulesDigest !== "string" || !HEX.test(v.rulesDigest)
    || !privateExitSnapshotValid(v.exit) || (v.trigger !== "interval" && v.trigger !== "dip") || !Number.isSafeInteger(v.runtimeVersion)
    || (v.runtimeVersion as number) < 0 || typeof v.planDigest !== "string" || !HEX.test(v.planDigest)
    || !PRIVATE_DCA_ADD_STATES.includes(v.state as PrivateDcaAddState) || !nullable(v.reason, (item) => typeof item === "string" && REASON.test(item))
    || !nullable(v.attemptKey, (item) => typeof item === "string" && ATTEMPT.test(item)) || !isTimestamp(v.createdAt) || !isTimestamp(v.updatedAt)
    || v.updatedAt < v.createdAt) fail();
  const state = v.state as PrivateDcaAddState;
  // Shape: an attempt key only once signed; every failed or ambiguous outcome names its reason; running names none.
  const attempt = v.attemptKey !== null;
  const ok = state === "running" ? !attempt && v.reason === null
    : state === "submitted" || state === "opened" ? attempt
      : state === "not_landed" ? v.reason !== null
        : !attempt && v.reason !== null;
  if (!ok) fail();
  const add: PrivateDcaAdd = { reservationId: v.reservationId, mint: v.mint as string, walletAddress: v.walletAddress as string,
    parentEntryBuildDigest: v.parentEntryBuildDigest, amountLamports: v.amountLamports, slippageBps: v.slippageBps as number,
    ruleRevisionId: v.ruleRevisionId, rulesDigest: v.rulesDigest, exit: structuredClone(v.exit) as PrivateExitSnapshot, trigger: v.trigger,
    runtimeVersion: v.runtimeVersion as number, planDigest: v.planDigest, state, reason: v.reason as string | null,
    attemptKey: v.attemptKey as string | null, createdAt: v.createdAt, updatedAt: v.updatedAt };
  // The plan digest binds every plan field (a tampered or mis-copied record never opens a lot or builds).
  if (privateDcaPlanDigest({ ...scope, reservationId: add.reservationId, mint: add.mint, walletAddress: add.walletAddress,
    parentEntryBuildDigest: add.parentEntryBuildDigest, amountLamports: add.amountLamports, slippageBps: add.slippageBps,
    ruleRevisionId: add.ruleRevisionId, rulesDigest: add.rulesDigest, exit: add.exit, trigger: add.trigger, runtimeVersion: add.runtimeVersion,
    createdAt: add.createdAt }) !== add.planDigest) fail();
  return add;
}
interface Snapshot { schemaVersion: 1; localProfileId: string; agentId: string; lastObservedAt: number; campaigns: PrivateDcaCampaign[]; adds: PrivateDcaAdd[] }
function parseSnapshot(value: unknown, scope: { localProfileId: string; agentId: string }): Snapshot {
  exact(value, ["schemaVersion", "localProfileId", "agentId", "lastObservedAt", "campaigns", "adds"]);
  if (value.schemaVersion !== 1 || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId || !isTimestamp(value.lastObservedAt)
    || !Array.isArray(value.campaigns) || value.campaigns.length > PRIVATE_DCA_MAX_CAMPAIGNS || !Array.isArray(value.adds)
    || value.adds.length > PRIVATE_DCA_MAX_ADDS) fail();
  const campaigns = (value.campaigns as unknown[]).map(parseCampaign);
  const adds = (value.adds as unknown[]).map((item) => parseAdd(item, scope));
  const mark = value.lastObservedAt as number;
  if (new Set(campaigns.map((item) => item.mint)).size !== campaigns.length || new Set(adds.map((item) => item.reservationId)).size !== adds.length
    || campaigns.some((item) => item.updatedAt > mark) || adds.some((item) => item.updatedAt > mark)
    || adds.filter((item) => item.state === "running").length > 1) fail();
  return { schemaVersion: 1, ...scope, lastObservedAt: mark, campaigns, adds };
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
export function privateDcaStoreFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `dca-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}

export interface PrivateDcaStoreOptions { directory: string; localProfileId: string; agentIds: readonly string[]; assertAvailable(): void }
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<Snapshot> };

export class PrivateDcaStore {
  readonly #options: PrivateDcaStoreOptions;
  readonly #agentIds: string[];
  readonly #slots = new Map<string, Slot>();
  #closed = false;
  constructor(options: PrivateDcaStoreOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.assertAvailable !== "function") fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, directory: path.resolve(options.directory), agentIds: this.#agentIds };
  }
  /** An agent added to the running daemon (agent-roster.ts). */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  /** Read-only; an agent without DCA records creates no file. */
  read(agentId: string): PrivateDcaSnapshotView {
    const snapshot = this.#read(agentId, false);
    return freeze({ campaigns: (snapshot?.campaigns ?? []).map((item) => structuredClone(item)), adds: (snapshot?.adds ?? []).map((item) => structuredClone(item)) });
  }
  add(agentId: string, reservationId: string): PrivateDcaAdd | undefined { return this.read(agentId).adds.find((item) => item.reservationId === reservationId); }
  campaign(agentId: string, mint: string): PrivateDcaCampaign | undefined { return this.read(agentId).campaigns.find((item) => item.mint === mint); }

  /** Starts the mint's campaign from its current opening buys, or folds opening buys it has not seen into a running one (monotonic:
   * a folded buy's cost is added once; the newest buy becomes the last-buy reference). An ended campaign is returned unchanged, except
   * a restartable (holding_closed) one, which a new holding replaces. */
  fold(agentId: string, mint: string, buys: readonly PrivateDcaFoldedBuy[], nowMs: number): PrivateDcaCampaign {
    if (!isSolanaAddress(mint) || !Array.isArray(buys) || buys.some((buy) => !isRecord(buy) || typeof buy.reservationId !== "string"
      || !UUID4.test(buy.reservationId) || !u64(buy.costLamports) || !u64(buy.units) || !isTimestamp(buy.at))) fail();
    return this.#mutate(agentId, nowMs, false, (snapshot, at) => {
      const index = snapshot.campaigns.findIndex((item) => item.mint === mint);
      const existing = snapshot.campaigns[index];
      if (existing && existing.endReason !== null && (PRIVATE_DCA_PROTECTIVE_ENDS.includes(existing.endReason) || buys.length === 0)) {
        return { next: undefined, result: existing };
      }
      const restart = !existing || existing.endReason !== null;
      if (restart && buys.length === 0) fail("campaign_missing");
      let campaign: PrivateDcaCampaign = restart ? { mint, startedAt: at, spentLamports: "0", lots: 0, folded: [],
        lastBuy: { at: 0, costLamports: "0", units: null, reservationId: null }, endedAt: null, endReason: null, updatedAt: at } : structuredClone(existing!);
      let changed = restart;
      const presented = new Set(buys.map((buy) => buy.reservationId));
      for (const buy of [...buys].sort((a, b) => a.at - b.at)) {
        if (campaign.folded.includes(buy.reservationId)) continue;
        const spent = BigInt(campaign.spentLamports) + BigInt(buy.costLamports);
        if (spent > U64_MAX) fail();
        campaign = { ...campaign, spentLamports: spent.toString(), folded: trimFolded([...campaign.folded, buy.reservationId], presented),
          lastBuy: buy.at >= campaign.lastBuy.at ? { at: buy.at, costLamports: buy.costLamports, units: buy.units, reservationId: buy.reservationId } : campaign.lastBuy };
        changed = true;
      }
      if (!changed) return { next: undefined, result: existing! };
      campaign = { ...campaign, updatedAt: at };
      let campaigns = [...snapshot.campaigns];
      if (index >= 0) campaigns[index] = campaign;
      else {
        if (campaigns.length >= PRIVATE_DCA_MAX_CAMPAIGNS) {
          // Only a restartable ended campaign makes room; one ended by a protective exit is kept for good.
          const oldest = campaigns.filter((item) => item.endReason === "holding_closed").sort((a, b) => a.updatedAt - b.updatedAt)[0];
          if (!oldest) fail("capacity_exhausted");
          campaigns = campaigns.filter((item) => item !== oldest);
        }
        campaigns.push(campaign);
      }
      return { next: { ...snapshot, campaigns }, result: campaign };
    });
  }
  /** Ends the mint's campaign (idempotent). A protective end is recorded even without a campaign (so none ever starts for the mint) and
   * replaces a restartable one; a restartable end never replaces a protective one. */
  end(agentId: string, mint: string, reason: PrivateDcaEndReason, nowMs: number): PrivateDcaCampaign | undefined {
    if (!isSolanaAddress(mint) || !PRIVATE_DCA_END_REASONS.includes(reason)) fail();
    const protective = PRIVATE_DCA_PROTECTIVE_ENDS.includes(reason);
    // A protective end must land even while the wall clock is behind the mark (it only ever stops adds).
    return this.#mutate(agentId, nowMs, protective, (snapshot, at) => {
      const index = snapshot.campaigns.findIndex((item) => item.mint === mint);
      const existing = snapshot.campaigns[index];
      if (!existing && !protective) return { next: undefined, result: undefined };
      if (existing && (privateDcaCampaignProtectiveEnd(existing) || (existing.endReason !== null && !protective))) return { next: undefined, result: existing };
      const campaign: PrivateDcaCampaign = existing ? { ...structuredClone(existing), endedAt: at, endReason: reason, updatedAt: at }
        : { mint, startedAt: at, spentLamports: "0", lots: 0, folded: [], lastBuy: { at: 0, costLamports: "0", units: null, reservationId: null },
          endedAt: at, endReason: reason, updatedAt: at };
      let campaigns = [...snapshot.campaigns];
      if (index >= 0) campaigns[index] = campaign;
      else {
        if (campaigns.length >= PRIVATE_DCA_MAX_CAMPAIGNS) {
          const oldest = campaigns.filter((item) => item.endReason === "holding_closed").sort((a, b) => a.updatedAt - b.updatedAt)[0];
          if (!oldest) fail("capacity_exhausted");
          campaigns = campaigns.filter((item) => item !== oldest);
        }
        campaigns.push(campaign);
      }
      return { next: { ...snapshot, campaigns }, result: campaign };
    });
  }
  /** Writes a new add `running` (durable before any reservation or network call). Refuses a second running add of the agent, any add
   * of a mint whose earlier add is unsettled, an ended or missing campaign, the lot cap, and a reused reservationId. `keep`: the entry
   * reservationIds of lots still held (not closed); their opened adds are never evicted for room (capacity_exhausted instead). */
  begin(agentId: string, input: PrivateDcaAddInput, nowMs: number, keep: ReadonlySet<string> = new Set()): PrivateDcaAdd {
    if (!isRecord(input)) fail();
    return this.#mutate(agentId, nowMs, false, (snapshot, at) => {
      if (input.createdAt !== at) fail();
      const add = parseAdd({ ...input, state: "running", reason: null, attemptKey: null, updatedAt: at }, { localProfileId: this.#options.localProfileId, agentId });
      if (snapshot.adds.some((item) => item.reservationId === add.reservationId)) fail("add_conflict");
      if (snapshot.adds.some((item) => item.state === "running")) fail("add_running");
      if (snapshot.adds.some((item) => item.mint === add.mint && privateDcaAddUnsettled(item))) fail("add_unsettled");
      const campaign = snapshot.campaigns.find((item) => item.mint === add.mint);
      if (!campaign) fail("campaign_missing");
      if (campaign.endReason !== null) fail("campaign_ended");
      if (campaign.lots >= PRIVATE_DCA_MAX_LOTS_PER_MINT) fail("lot_cap");
      let adds = [...snapshot.adds];
      if (adds.length >= PRIVATE_DCA_MAX_ADDS) {
        const oldest = adds.filter((item) => evictable(item, keep)).sort((a, b) => a.updatedAt - b.updatedAt)[0];
        if (!oldest) fail("capacity_exhausted");
        adds = adds.filter((item) => item !== oldest);
      }
      return { next: { ...snapshot, adds: [...adds, add] }, result: add };
    });
  }
  /** Compare-and-set on the add's state. Signed (submitted): the campaign's spend and lot count grow by exactly this add (never refunded)
   * and it becomes the last buy. Opened: the last buy learns its units when it is this add. The outcome of a `running` add is recorded
   * even while the wall clock is behind the mark (clamped to it), so a clock step never leaves it running. */
  update(agentId: string, reservationId: string, expected: PrivateDcaAddState, change: PrivateDcaAddChange, nowMs: number): PrivateDcaAdd {
    const allowed: Readonly<Record<PrivateDcaAddState, readonly PrivateDcaAddState[]>> = { running: ["submitted", "refused", "held"],
      held: ["submitted", "refused"], submitted: ["opened", "not_landed"], opened: [], not_landed: [], refused: [] };
    if (!isRecord(change) || !allowed[expected]?.includes(change.state)) fail();
    return this.#mutate(agentId, nowMs, expected === "running", (snapshot, at) => {
      const index = snapshot.adds.findIndex((item) => item.reservationId === reservationId);
      const existing = snapshot.adds[index];
      if (!existing || existing.state !== expected) fail("add_conflict");
      const fields = change.state === "submitted" ? { state: change.state, attemptKey: change.attemptKey, reason: change.reason }
        : change.state === "opened" ? { state: change.state, reason: null }
          : { state: change.state, reason: change.reason };
      if (change.state === "opened" && !u64(change.units)) fail();
      const next = parseAdd({ ...existing, ...fields, updatedAt: Math.max(at, existing.updatedAt) }, { localProfileId: this.#options.localProfileId, agentId });
      const adds = [...snapshot.adds]; adds[index] = next;
      let campaigns = snapshot.campaigns;
      const ci = campaigns.findIndex((item) => item.mint === existing.mint);
      const campaign = campaigns[ci];
      if (campaign && change.state === "submitted") {
        const spent = BigInt(campaign.spentLamports) + BigInt(existing.amountLamports);
        campaigns = [...campaigns];
        campaigns[ci] = { ...structuredClone(campaign), spentLamports: (spent > U64_MAX ? U64_MAX : spent).toString(),
          lots: Math.min(PRIVATE_DCA_MAX_LOTS_PER_MINT, campaign.lots + 1),
          lastBuy: { at: next.updatedAt, costLamports: existing.amountLamports, units: null, reservationId }, updatedAt: next.updatedAt };
      } else if (campaign && change.state === "opened" && campaign.lastBuy.reservationId === reservationId) {
        campaigns = [...campaigns];
        campaigns[ci] = { ...structuredClone(campaign), lastBuy: { ...campaign.lastBuy, units: change.units }, updatedAt: next.updatedAt };
      }
      return { next: { ...snapshot, adds, campaigns }, result: next };
    });
  }
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Preserve files. */ } }
    this.#slots.clear();
  }
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
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      let parsed: Snapshot;
      try { parsed = parseSnapshot(structuredClone({ ...next, lastObservedAt: Math.max(at, snapshot.lastObservedAt) }), scope); } catch { return fail(); }
      if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_BYTES) fail("capacity_exhausted");
      try { slot.storage.commit(parsed); }
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
    const files = privateDcaStoreFiles(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#options.directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { if (!create && !exists(files.markerFile) && !exists(files.snapshotFile)) return undefined; }
    catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
    try {
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      const storage = new OwnedJsonSnapshot<Snapshot>({ directory: this.#options.directory, ...files,
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId, kind: "dca" }, maximumBytes: MAX_BYTES,
        initial: { schemaVersion: 1, ...scope, lastObservedAt: 0, campaigns: [], adds: [] }, assertAvailable: this.#options.assertAvailable,
        decode: (value) => parseSnapshot(value, scope) });
      const slot: Slot = { kind: "open", storage }; this.#slots.set(agentId, slot); return slot;
    } catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
  }
}
