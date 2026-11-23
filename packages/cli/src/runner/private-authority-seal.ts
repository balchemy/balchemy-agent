/** A2a authority watermark (amendments section C): the owner-sealed upper bound of every stored value whose socket frame is raising.
 *
 * The probe (a2a-store-probe.spec.ts) showed that a same-user process can rewrite the spend caps, the sizing checkpoint, the rule
 * snapshot and the approval setting on disk with only public code and plain hashes, and the runner adopts them after a restart. This
 * record seals the owner's values with a purpose-fixed tag of the trading wallet's unlocked key (private-trading-keystore.ts
 * authorityTag, purpose `authority_watermark`). Current values must be equal to or tighter than the sealed ones, decided by the SAME
 * comparators as the socket gate (private-socket-proof.ts); equality where no order exists. Rules: the same head, or a head that is an
 * approval-on child of the sealed head. The RPC endpoint is sealed only as a keyed tag of its URL (never the URL); the host is kept
 * for display. The cap basis (how a percentage was fixed) is sealed for display only: the classifier treats a same-amount cap with
 * another basis as tightening, so the comparison does too.
 *
 * Fields are public; "sealed" means an HMAC tag, not encryption. Verifying needs an unlocked wallet (`wallet_locked` otherwise). A
 * deleted record is `unsealed`, indistinguishable from an agent never sealed (documented residual). This store never decides when
 * to seal: the daemon seals inside a proven raising change, on a tightening write while unlocked, and never to looser values by
 * itself (`onlyIfTighter`). One snapshot per agent, `authority-seal-<sha256(agentId)>.json` + `.initialized`, created only by a seal. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { RUNNER_LAUNCHPAD_ID } from "@balchemyai/agent-sdk";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { addRunnerAgent } from "./agent-roster.js";
import { parsePrivateCapBasis, parsePrivateCapSetting, type PrivateCapBasis, type PrivateCapSetting } from "./private-spend-cap.js";
import { parsePrivateSolAmount } from "./private-sizing.js";
import { isPrivateSolanaRpcHost, parsePrivateSolanaRpcEndpoint } from "./private-solana-rpc.js";
import { autonomyRaise, budgetRaise, capsRaise, launchpadRaise, priceRaise, PRIVATE_AUTHORITY_FIELDS, ruleConfirmRaise, sizingRaise,
  type PrivateAuthorityField, type SocketProofModelPrice, type SocketProofRuleProposal } from "./private-socket-proof.js";
import type { PrivateAuthorityTagPurpose } from "./private-trading-keystore.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";

export const PRIVATE_AUTHORITY_SEAL_SUITE = "hkdf-sha256+hmac-sha256/v1" as const;
const RECORD_TUPLE = "balchemy.authority-watermark.record.v1";
const RPC_URL_TUPLE = "balchemy.authority-watermark.rpc-url.v1";
const MAX_RECORD_BYTES = 32 * 1024;
const MAX_LAUNCHPADS = 64;
const REVISION_ID = /^brr_[a-f0-9]{64}$/;
const TAG = /^[0-9a-f]{64}$/;
const MODEL_TEXT = /^[!-~]{1,200}$/;

/** The keystore primitive both A2a stores depend on (PrivateTradingKeystore satisfies it); injected, never constructed here. */
export interface PrivateAuthorityKeystore {
  status(agentId: string): TradingWalletStatus;
  authorityTag(agentId: string, purpose: PrivateAuthorityTagPurpose, fields: readonly string[]): string;
  verifyAuthorityTag(agentId: string, purpose: PrivateAuthorityTagPurpose, fields: readonly string[], tag: string): boolean;
}
export function privateAuthoritySealFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `authority-seal-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}

export type PrivateApprovalMode = "approval_required" | "automatic_within_limits";
export interface PrivateAuthorityCaps { perTrade: PrivateCapSetting; daily: PrivateCapSetting; perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null }
/** The current values the daemon reads from its stores (T2 wiring). `rules.headProposal` is the STORED proposal kind that produced the
 * head and `rules.parentRevisionId` its parent (null for revision 1 or no rules); the RPC URL is used only to compute its keyed tag. */
export interface PrivateAuthorityCurrent {
  caps: PrivateAuthorityCaps;
  sizing: { amountSol: string; slippageBps: number } | null;
  rules: { revisionId: string | null; approvalMode: PrivateApprovalMode | null; parentRevisionId: string | null; headProposal: SocketProofRuleProposal | null };
  rpc: { url: string } | null;
  model: { provider: string; model: string } | null;
  budget: { dailyLimitMicroUsd: number };
  modelPrice: SocketProofModelPrice | null;
  autonomy: { dailyCallLimit: number };
  launchpads: { ids: readonly string[] };
}
/** What the seal card shows (RPC host only) and what `authorityDigest` commits to. Keys equal PRIVATE_AUTHORITY_FIELDS. */
export interface PrivateAuthorityView {
  caps: PrivateAuthorityCaps;
  sizing: { amountSol: string; amountBaseUnits: string; slippageBps: number } | null;
  rules: { revisionId: string | null; approvalMode: PrivateApprovalMode | null };
  rpc: { host: string } | null;
  model: { provider: string; model: string } | null;
  budget: { dailyLimitMicroUsd: number };
  modelPrice: SocketProofModelPrice | null;
  autonomy: { dailyCallLimit: number };
  launchpads: { ids: string[] };
}
/** The sealed values: the view plus the keyed RPC URL tag. */
export type PrivateAuthoritySealedValues = Omit<PrivateAuthorityView, "rpc"> & { rpc: { host: string; urlTag: string } | null };
interface SealRecord {
  schemaVersion: 1; suite: typeof PRIVATE_AUTHORITY_SEAL_SUITE; localProfileId: string; agentId: string; sealedAt: number;
  values: PrivateAuthoritySealedValues; mac: string;
}
export type PrivateAuthoritySealState = "unsealed" | "sealed_locked" | "sealed" | "looser" | "invalid" | "held";
export interface PrivateAuthoritySealStatus {
  state: PrivateAuthoritySealState; current: PrivateAuthorityView; currentDigest: string; looser: PrivateAuthorityField[]; sealedAt: number | null;
}
export type PrivateAuthorityCheck = { ok: true; sealedAt: number }
  | { ok: false; code: "authority_unsealed"; reason: "missing" | "invalid" | "looser"; looser: PrivateAuthorityField[] }
  | { ok: false; code: "wallet_locked" | "wallet_missing" | "state_unavailable" };
export type PrivateAuthoritySealErrorCode = "invalid_request" | "unknown_agent" | "closing" | "state_unavailable" | "write_outcome_unknown"
  | "wallet_locked" | "wallet_missing" | "shown_mismatch" | "authority_unsealed";
export class PrivateAuthoritySealError extends Error {
  constructor(readonly code: PrivateAuthoritySealErrorCode) { super(`Authority seal ${code}`); this.name = "PrivateAuthoritySealError"; }
}
function fail(code: PrivateAuthoritySealErrorCode): never { throw new PrivateAuthoritySealError(code); }
/** Maps a keystore refusal (wallet_locked, wallet_missing, anything else) to a closed code. */
export function privateAuthorityKeystoreCode(error: unknown): "wallet_locked" | "wallet_missing" | "state_unavailable" {
  const code = isRecord(error) ? error.code : undefined;
  return code === "wallet_locked" || code === "wallet_missing" ? code : "state_unavailable";
}

/** Sorted-key JSON: one encoding per value, whatever order the keys were built in. */
export function privateAuthorityCanonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(privateAuthorityCanonical).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${privateAuthorityCanonical(value[key])}`).join(",")}}`;
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail("invalid_request");
  return encoded;
}
/** The digest the seal frame echoes: sha256 over the canonical view, hex. */
export function privateAuthorityViewDigest(view: PrivateAuthorityView): string {
  return createHash("sha256").update(privateAuthorityCanonical(["balchemy.authority-watermark.view.v1", view]), "utf8").digest("hex");
}

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid_request");
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) fail("invalid_request");
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("invalid_request");
  return value;
}
function guarded<T>(read: () => T): T { try { return read(); } catch { return fail("invalid_request"); } }
function caps(value: unknown): PrivateAuthorityCaps {
  exact(value, ["perTrade", "daily", "perTradeBasis", "dailyBasis"]);
  const { perTrade, daily, perTradeBasis, dailyBasis } = value;
  return guarded(() => ({ perTrade: parsePrivateCapSetting(perTrade, { allowUnset: true }), daily: parsePrivateCapSetting(daily, { allowUnset: true }),
    perTradeBasis: parsePrivateCapBasis(perTradeBasis), dailyBasis: parsePrivateCapBasis(dailyBasis) }));
}
/** Any host the RPC endpoint parser derives (private-solana-rpc.ts), so every accepted endpoint can be sealed and shown. */
function host(value: unknown): string {
  if (!isPrivateSolanaRpcHost(value)) fail("invalid_request");
  return value;
}
function revisionId(value: unknown): string | null {
  if (value !== null && (typeof value !== "string" || !REVISION_ID.test(value))) fail("invalid_request");
  return value;
}
function approvalMode(value: unknown): PrivateApprovalMode | null {
  if (value !== null && value !== "approval_required" && value !== "automatic_within_limits") fail("invalid_request");
  return value;
}
function model(value: unknown): { provider: string; model: string } | null {
  if (value === null) return null;
  exact(value, ["provider", "model"]);
  if (typeof value.provider !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(value.provider) || typeof value.model !== "string" || !MODEL_TEXT.test(value.model)) fail("invalid_request");
  return { provider: value.provider, model: value.model };
}
function price(value: unknown): SocketProofModelPrice | null {
  if (value === null) return null;
  exact(value, ["provider", "model", "inputMicroUsdPerMillion", "outputMicroUsdPerMillion"]);
  const named = model({ provider: value.provider, model: value.model });
  if (!named) return fail("invalid_request");
  return { ...named, inputMicroUsdPerMillion: count(value.inputMicroUsdPerMillion), outputMicroUsdPerMillion: count(value.outputMicroUsdPerMillion) };
}
function launchpads(value: unknown): { ids: string[] } {
  exact(value, ["ids"]);
  const ids = value.ids;
  if (!Array.isArray(ids) || ids.length > MAX_LAUNCHPADS) fail("invalid_request");
  const list: string[] = [];
  for (const item of ids as unknown[]) {
    if (typeof item !== "string" || !RUNNER_LAUNCHPAD_ID.test(item) || (list.length > 0 && list[list.length - 1]! >= item)) fail("invalid_request");
    list.push(item);
  }
  return { ids: list };
}
function sizingView(value: unknown): PrivateAuthorityView["sizing"] {
  if (value === null) return null;
  exact(value, ["amountSol", "amountBaseUnits", "slippageBps"]);
  const amountSol = value.amountSol;
  const amount = guarded(() => parsePrivateSolAmount(amountSol));
  if (amount.amountSol !== value.amountSol || amount.amountBaseUnits !== value.amountBaseUnits) fail("invalid_request");
  const slippageBps = count(value.slippageBps);
  if (slippageBps < 1 || slippageBps > 10_000) fail("invalid_request");
  return { amountSol: amount.amountSol, amountBaseUnits: amount.amountBaseUnits, slippageBps };
}
/** Strict closed check of the daemon-supplied current values. */
export function parsePrivateAuthorityCurrent(value: unknown): PrivateAuthorityCurrent {
  exact(value, PRIVATE_AUTHORITY_FIELDS);
  let sizing: PrivateAuthorityCurrent["sizing"] = null;
  const rawSizing = value.sizing;
  if (rawSizing !== null) {
    exact(rawSizing, ["amountSol", "slippageBps"]);
    const amountSol = rawSizing.amountSol;
    const amount = guarded(() => parsePrivateSolAmount(amountSol));
    const view = sizingView({ amountSol: amount.amountSol, amountBaseUnits: amount.amountBaseUnits, slippageBps: rawSizing.slippageBps });
    sizing = view ? { amountSol: view.amountSol, slippageBps: view.slippageBps } : null;
  }
  const rules = value.rules;
  exact(rules, ["revisionId", "approvalMode", "parentRevisionId", "headProposal"]);
  let headProposal: SocketProofRuleProposal | null = null;
  const head = rules.headProposal;
  if (head !== null) {
    if (!isRecord(head)) fail("invalid_request");
    if (head.kind === "approval") {
      exact(head, ["kind", "setting"]);
      if (head.setting !== "on" && head.setting !== "off") fail("invalid_request");
      headProposal = { kind: "approval", setting: head.setting };
    } else {
      exact(head, ["kind"]);
      if (head.kind !== "edit" && head.kind !== "rollback") fail("invalid_request");
      headProposal = { kind: head.kind };
    }
  }
  let rpc: PrivateAuthorityCurrent["rpc"] = null;
  const rawRpc = value.rpc;
  if (rawRpc !== null) {
    exact(rawRpc, ["url"]);
    const url = rawRpc.url;
    rpc = { url: guarded(() => parsePrivateSolanaRpcEndpoint(url)).url };
  }
  const budget = value.budget; const autonomy = value.autonomy;
  exact(budget, ["dailyLimitMicroUsd"]); exact(autonomy, ["dailyCallLimit"]);
  return { caps: caps(value.caps), sizing,
    rules: { revisionId: revisionId(rules.revisionId), approvalMode: approvalMode(rules.approvalMode), parentRevisionId: revisionId(rules.parentRevisionId), headProposal },
    rpc, model: model(value.model), budget: { dailyLimitMicroUsd: count(budget.dailyLimitMicroUsd) }, modelPrice: price(value.modelPrice),
    autonomy: { dailyCallLimit: count(autonomy.dailyCallLimit) }, launchpads: launchpads(value.launchpads) };
}
/** The display view of current values (RPC host only). */
export function privateAuthorityView(current: PrivateAuthorityCurrent): PrivateAuthorityView {
  const sizing = current.sizing ? parsePrivateSolAmount(current.sizing.amountSol) : null;
  return { caps: structuredClone(current.caps),
    sizing: sizing && current.sizing ? { amountSol: sizing.amountSol, amountBaseUnits: sizing.amountBaseUnits, slippageBps: current.sizing.slippageBps } : null,
    rules: { revisionId: current.rules.revisionId, approvalMode: current.rules.approvalMode },
    rpc: current.rpc ? { host: parsePrivateSolanaRpcEndpoint(current.rpc.url).host } : null,
    model: current.model ? { ...current.model } : null, budget: { ...current.budget }, modelPrice: current.modelPrice ? { ...current.modelPrice } : null,
    autonomy: { ...current.autonomy }, launchpads: { ids: [...current.launchpads.ids] } };
}
/** Closed parser of a view (the owner-pin channel reply carries one). */
/** The common fields of a view and of sealed values (everything but `rpc`). */
function viewFields(value: Record<string, unknown>): Omit<PrivateAuthorityView, "rpc"> {
  const rules = value.rules; const budget = value.budget; const autonomy = value.autonomy;
  exact(rules, ["revisionId", "approvalMode"]); exact(budget, ["dailyLimitMicroUsd"]); exact(autonomy, ["dailyCallLimit"]);
  return { caps: caps(value.caps), sizing: sizingView(value.sizing),
    rules: { revisionId: revisionId(rules.revisionId), approvalMode: approvalMode(rules.approvalMode) },
    model: model(value.model), budget: { dailyLimitMicroUsd: count(budget.dailyLimitMicroUsd) }, modelPrice: price(value.modelPrice),
    autonomy: { dailyCallLimit: count(autonomy.dailyCallLimit) }, launchpads: launchpads(value.launchpads) };
}
/** Closed parser of a view (the owner-pin channel reply carries one). */
export function parsePrivateAuthorityView(value: unknown): PrivateAuthorityView {
  exact(value, PRIVATE_AUTHORITY_FIELDS);
  let rpc: PrivateAuthorityView["rpc"] = null;
  const raw = value.rpc;
  if (raw !== null) { exact(raw, ["host"]); rpc = { host: host(raw.host) }; }
  return { ...viewFields(value), rpc };
}
function sealedValues(value: unknown): PrivateAuthoritySealedValues {
  exact(value, PRIVATE_AUTHORITY_FIELDS);
  let rpc: PrivateAuthoritySealedValues["rpc"] = null;
  const raw = value.rpc;
  if (raw !== null) {
    exact(raw, ["host", "urlTag"]);
    if (typeof raw.urlTag !== "string" || !TAG.test(raw.urlTag)) fail("invalid_request");
    rpc = { host: host(raw.host), urlTag: raw.urlTag };
  }
  return { ...viewFields(value), rpc };
}

/** The looser fields of `current` against `sealed`, with the socket gate's comparators. `currentRpcTag` is the keyed tag of the current
 * RPC URL (null when there is none). Empty: covered. */
export function comparePrivateAuthority(sealed: PrivateAuthoritySealedValues, current: PrivateAuthorityCurrent, currentRpcTag: string | null): PrivateAuthorityField[] {
  const looser: PrivateAuthorityField[] = [];
  const same = (left: unknown, right: unknown): boolean => privateAuthorityCanonical(left) === privateAuthorityCanonical(right);
  if (capsRaise(sealed.caps, current.caps)) looser.push("caps");
  // A first sizing is raising; removing it only refuses (sizing_missing).
  if (current.sizing && (!sealed.sizing || sizingRaise({ amountSol: sealed.sizing.amountSol, slippageBps: sealed.sizing.slippageBps }, current.sizing))) looser.push("sizing");
  const rules = current.rules;
  const sameHead = rules.revisionId === sealed.rules.revisionId && rules.approvalMode === sealed.rules.approvalMode;
  const approvalOnChild = sealed.rules.revisionId !== null && rules.parentRevisionId === sealed.rules.revisionId && rules.headProposal !== null
    && !ruleConfirmRaise(rules.headProposal) && rules.approvalMode === "approval_required";
  if (!sameHead && !approvalOnChild) looser.push("rules");
  if (!(sealed.rpc === null ? currentRpcTag === null : currentRpcTag === sealed.rpc.urlTag)) looser.push("rpc");
  if (!same(sealed.model, current.model)) looser.push("model");
  if (budgetRaise(sealed.budget.dailyLimitMicroUsd, current.budget.dailyLimitMicroUsd)) looser.push("budget");
  if (!(sealed.modelPrice === null ? current.modelPrice === null : current.modelPrice !== null && !priceRaise(sealed.modelPrice, current.modelPrice))) looser.push("modelPrice");
  if (autonomyRaise(sealed.autonomy.dailyCallLimit, current.autonomy.dailyCallLimit)) looser.push("autonomy");
  if (launchpadRaise(sealed.launchpads.ids, current.launchpads.ids)) looser.push("launchpads");
  return looser;
}

/** The re-seal after a proven launchpad set (daemon.ts resealAuthority): the mirror read afterwards may already come from a later,
 * proof-free refresh, so the field is re-sealed only when every current id is one the proven frame named (equal or a subset). */
export function privateLaunchpadsWithinProven(current: readonly string[], proven: readonly string[]): boolean { return !launchpadRaise(proven, current); }

/** Lazy per-agent records over OwnedJsonSnapshot (the pattern of private-solana-rpc-settings.ts): a read never creates a file; only
 * `write` does. The snapshot holds the raw JSON and every read decodes it, so an undecodable (tampered) record reads as
 * `state_unavailable` yet can still be REPLACED by an explicit write (the owner's proven seal step). A partial, foreign, moved or
 * replaced-under-us record is held until restart; a record whose two files are both gone reads as absent again. Shared by the owner
 * pin (private-owner-pin.ts) and this store. */
export interface PrivateAgentRecordOptions<T> {
  directory: string; localProfileId: string; agentIds: string[]; kind: string; maximumBytes: number;
  files(agentId: string): { snapshotFile: string; markerFile: string };
  decode(value: unknown, agentId: string): T;
  assertAvailable(): void;
}
type RecordSlot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<unknown> };
export class PrivateAgentRecords<T> {
  readonly #options: PrivateAgentRecordOptions<T>;
  readonly #directory: string;
  readonly #slots = new Map<string, RecordSlot>();
  #closed = false;
  constructor(options: PrivateAgentRecordOptions<T>) {
    if (!isRecord(options) || !isId(options.localProfileId) || !Array.isArray(options.agentIds) || options.agentIds.length < 1 || options.agentIds.length > 64
      || options.agentIds.some((id) => !isId(id)) || new Set(options.agentIds).size !== options.agentIds.length || typeof options.decode !== "function"
      || typeof options.assertAvailable !== "function" || typeof options.directory !== "string" || !path.isAbsolute(options.directory)) fail("invalid_request");
    this.#options = options; this.#directory = path.resolve(options.directory);
  }
  addAgent(agentId: string): void { addRunnerAgent(this.#options.agentIds, agentId); }
  /** Closed precondition of every call: open, a known agent and the daemon's writer capability. */
  available(agentId: string): void {
    if (this.#closed) fail("closing");
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent");
    try { this.#options.assertAvailable(); } catch { fail("state_unavailable"); }
  }
  /** Either file of this agent exists on disk (never opens or creates one). */
  present(agentId: string): boolean {
    const files = this.#options.files(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { return exists(files.markerFile) || exists(files.snapshotFile); } catch { return fail("state_unavailable"); }
  }
  /** undefined: no record. Throws `state_unavailable` for a held, partial or undecodable record. */
  read(agentId: string): T | undefined {
    this.available(agentId);
    if (!this.present(agentId)) { this.#drop(agentId); return undefined; }
    const slot = this.#slots.get(agentId) ?? this.#open(agentId, null);
    if (slot.kind === "held") return fail("state_unavailable");
    let raw: unknown;
    try { raw = slot.storage.read(); } catch { this.#hold(agentId); return fail("state_unavailable"); }
    try { return this.#options.decode(raw, agentId); } catch { return fail("state_unavailable"); }
  }
  /** Creates or replaces the record (also an undecodable one). A held record refuses `state_unavailable` before any write; a failure
   * from the write on is `write_outcome_unknown`. */
  write(agentId: string, next: T): void {
    this.available(agentId);
    const present = this.present(agentId);
    if (!present) this.#drop(agentId);
    let slot = this.#slots.get(agentId);
    if (present && !slot) slot = this.#open(agentId, null);
    if (slot?.kind === "held") fail("state_unavailable");
    try {
      if (slot) slot.storage.commit(next);
      else if (this.#open(agentId, next).kind !== "open") throw new Error("not written");
    } catch { this.#hold(agentId); fail("write_outcome_unknown"); }
  }
  close(): void {
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Closed regardless. */ } }
    this.#slots.clear();
  }
  /** `initial` null opens an existing record only: the snapshot's decode refuses null before anything is written. */
  #open(agentId: string, initial: T | null): RecordSlot {
    let storage: OwnedJsonSnapshot<unknown> | undefined;
    try {
      storage = new OwnedJsonSnapshot<unknown>({ directory: this.#directory, ...this.#options.files(agentId),
        marker: { schemaVersion: 1, localProfileId: this.#options.localProfileId, agentId, kind: this.#options.kind },
        maximumBytes: this.#options.maximumBytes, initial, assertAvailable: this.#options.assertAvailable,
        decode: (value: unknown): unknown => { if (value === null || !isRecord(value)) throw new Error("absent"); return value; } });
      const slot: RecordSlot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch {
      try { storage?.close(); } catch { /* Preserve files; no detail leaves this boundary. */ }
      return this.#hold(agentId);
    }
  }
  #hold(agentId: string): RecordSlot {
    const current = this.#slots.get(agentId);
    if (current?.kind === "open") { try { current.storage.close(); } catch { /* Held regardless. */ } }
    const held: RecordSlot = { kind: "held" }; this.#slots.set(agentId, held); return held;
  }
  #drop(agentId: string): void {
    const current = this.#slots.get(agentId);
    if (current?.kind === "open") { try { current.storage.close(); } catch { /* Dropped regardless. */ } }
    this.#slots.delete(agentId);
  }
}

export interface PrivateAuthoritySealsOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this store never creates a second lock. */
  assertAvailable(): void;
  keystore: PrivateAuthorityKeystore;
  now?(): number;
}
export class PrivateAuthoritySeals {
  readonly #options: PrivateAuthoritySealsOptions;
  readonly #records: PrivateAgentRecords<SealRecord>;
  constructor(options: PrivateAuthoritySealsOptions) {
    if (!isRecord(options) || typeof options.keystore !== "object" || options.keystore === null || typeof options.keystore.authorityTag !== "function"
      || typeof options.keystore.verifyAuthorityTag !== "function" || typeof options.keystore.status !== "function"
      || (options.now !== undefined && typeof options.now !== "function")) fail("invalid_request");
    this.#options = options;
    this.#records = new PrivateAgentRecords<SealRecord>({ directory: options.directory, localProfileId: options.localProfileId,
      agentIds: [...options.agentIds], kind: "authority_seal", maximumBytes: MAX_RECORD_BYTES, files: privateAuthoritySealFiles,
      assertAvailable: options.assertAvailable, decode: (value, agentId) => this.#decode(value, agentId) });
  }
  addAgent(agentId: string): void { this.#records.addAgent(agentId); }
  /** True when a record (or a partial one) exists on disk: the no-wallet bootstrap exception must not apply then. */
  exists(agentId: string): boolean { this.#records.available(agentId); return this.#records.present(agentId); }

  /** What the seal card shows: the current values, their digest, and how they stand against the seal. Never writes. */
  status(agentId: string, input: PrivateAuthorityCurrent): PrivateAuthoritySealStatus {
    const current = parsePrivateAuthorityCurrent(input);
    const view = privateAuthorityView(current);
    const base = { current: view, currentDigest: privateAuthorityViewDigest(view) };
    let record: SealRecord | undefined;
    try { record = this.#records.read(agentId); }
    catch (error: unknown) {
      if (error instanceof PrivateAuthoritySealError && error.code !== "state_unavailable") throw error;
      return { ...base, state: "invalid", looser: [], sealedAt: null };
    }
    if (!record) return { ...base, state: "unsealed", looser: [], sealedAt: null };
    const wallet = this.#wallet(agentId);
    if (wallet === "held") return { ...base, state: "held", looser: [], sealedAt: record.sealedAt };
    if (wallet !== "unlocked") return { ...base, state: wallet === "locked" ? "sealed_locked" : "invalid", looser: [], sealedAt: record.sealedAt };
    let checked: PrivateAuthorityField[] | null;
    try { checked = this.#verify(agentId, record, current); }
    catch (error: unknown) { return { ...base, state: privateAuthorityKeystoreCode(error) === "wallet_locked" ? "sealed_locked" : "held", looser: [], sealedAt: record.sealedAt }; }
    if (checked === null) return { ...base, state: "invalid", looser: [], sealedAt: record.sealedAt };
    return { ...base, state: checked.length ? "looser" : "sealed", looser: checked, sealedAt: record.sealedAt };
  }
  /** The authority read used at arm, entries resume and the entry choke point: covered, or the closed reason it is not. Throws only
   * `closing` or `unknown_agent` (and `invalid_request` for malformed current values). */
  verify(agentId: string, input: PrivateAuthorityCurrent): PrivateAuthorityCheck {
    const current = parsePrivateAuthorityCurrent(input);
    this.#records.available(agentId);
    let present: boolean;
    try { present = this.#records.present(agentId); } catch { return { ok: false, code: "state_unavailable" }; }
    if (!present) return { ok: false, code: "authority_unsealed", reason: "missing", looser: [] };
    const wallet = this.#wallet(agentId);
    if (wallet === "locked" || wallet === "absent") return { ok: false, code: wallet === "locked" ? "wallet_locked" : "wallet_missing" };
    if (wallet === "held") return { ok: false, code: "state_unavailable" };
    let record: SealRecord | undefined;
    try { record = this.#records.read(agentId); } catch { return { ok: false, code: "authority_unsealed", reason: "invalid", looser: [] }; }
    if (!record) return { ok: false, code: "authority_unsealed", reason: "missing", looser: [] };
    let looser: PrivateAuthorityField[] | null;
    try { looser = this.#verify(agentId, record, current); } catch (error: unknown) { return { ok: false, code: privateAuthorityKeystoreCode(error) }; }
    if (looser === null) return { ok: false, code: "authority_unsealed", reason: "invalid", looser: [] };
    return looser.length ? { ok: false, code: "authority_unsealed", reason: "looser", looser } : { ok: true, sealedAt: record.sealedAt };
  }
  /** Seals `current` (an unlocked wallet is required). `shownDigest`: the digest the card showed; any difference refuses
   * `shown_mismatch`. `onlyIfTighter`: re-seal after a tightening write only, refusing `authority_unsealed` when no valid seal exists or
   * `current` is looser than it (never an automatic seal to looser values). */
  seal(agentId: string, input: PrivateAuthorityCurrent, options: { shownDigest?: string; onlyIfTighter?: boolean } = {}): PrivateAuthoritySealStatus {
    const current = parsePrivateAuthorityCurrent(input);
    const view = privateAuthorityView(current);
    if (options.shownDigest !== undefined && options.shownDigest !== privateAuthorityViewDigest(view)) fail("shown_mismatch");
    this.#records.available(agentId);
    const wallet = this.#wallet(agentId);
    if (wallet !== "unlocked") fail(wallet === "locked" ? "wallet_locked" : wallet === "absent" ? "wallet_missing" : "state_unavailable");
    if (options.onlyIfTighter) {
      const check = this.verify(agentId, current);
      if (!check.ok) fail(check.code);
    }
    const now = (this.#options.now ?? Date.now)();
    if (!isTimestamp(now)) fail("state_unavailable");
    let values: PrivateAuthoritySealedValues; let mac: string;
    try {
      const urlTag = this.#rpcTag(agentId, current);
      values = { ...view, rpc: view.rpc && urlTag !== null ? { host: view.rpc.host, urlTag } : null };
      mac = this.#options.keystore.authorityTag(agentId, "authority_watermark", recordFields(now, values));
    } catch (error: unknown) { return fail(privateAuthorityKeystoreCode(error)); }
    const record: SealRecord = { schemaVersion: 1, suite: PRIVATE_AUTHORITY_SEAL_SUITE, localProfileId: this.#options.localProfileId, agentId,
      sealedAt: now, values, mac };
    this.#records.write(agentId, record);
    const written = this.#records.read(agentId);
    if (!written || written.mac !== mac || written.sealedAt !== now) fail("write_outcome_unknown");
    return this.status(agentId, current);
  }
  close(): void { this.#records.close(); }

  #wallet(agentId: string): "unlocked" | "locked" | "absent" | "held" {
    let status: TradingWalletStatus;
    try { status = this.#options.keystore.status(agentId); } catch { return "held"; }
    return status.state === "unlocked" ? "unlocked" : status.state === "locked" ? "locked" : status.state === "absent" ? "absent" : "held";
  }
  #rpcTag(agentId: string, current: PrivateAuthorityCurrent): string | null {
    return current.rpc ? this.#options.keystore.authorityTag(agentId, "authority_watermark", [RPC_URL_TUPLE, current.rpc.url]) : null;
  }
  /** null: the tag does not verify (tampered, foreign or another wallet). Otherwise the looser fields. Throws a keystore refusal. */
  #verify(agentId: string, record: SealRecord, current: PrivateAuthorityCurrent): PrivateAuthorityField[] | null {
    if (!this.#options.keystore.verifyAuthorityTag(agentId, "authority_watermark", recordFields(record.sealedAt, record.values), record.mac)) return null;
    return comparePrivateAuthority(record.values, current, this.#rpcTag(agentId, current));
  }
  #decode(value: unknown, agentId: string): SealRecord {
    exact(value, ["schemaVersion", "suite", "localProfileId", "agentId", "sealedAt", "values", "mac"]);
    if (value.schemaVersion !== 1 || value.suite !== PRIVATE_AUTHORITY_SEAL_SUITE || value.localProfileId !== this.#options.localProfileId
      || value.agentId !== agentId || !isTimestamp(value.sealedAt) || typeof value.mac !== "string" || !TAG.test(value.mac)) fail("invalid_request");
    return { schemaVersion: 1, suite: PRIVATE_AUTHORITY_SEAL_SUITE, localProfileId: this.#options.localProfileId, agentId, sealedAt: value.sealedAt,
      values: sealedValues(value.values), mac: value.mac };
  }
}
/** The keystore tuple of one record: a fixed kind, the suite, the time and the canonical values (the keystore adds purpose, profile,
 * agent and wallet address). */
function recordFields(sealedAt: number, values: PrivateAuthoritySealedValues): string[] {
  return [RECORD_TUPLE, PRIVATE_AUTHORITY_SEAL_SUITE, String(sealedAt), privateAuthorityCanonical(values)];
}
