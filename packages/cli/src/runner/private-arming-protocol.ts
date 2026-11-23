/** Owner-local IPC for S8a arming and spend limits (`private_arming`, the owner's 0600 socket only). Arming is CLI-only:
 * the server and the web can never reach this channel. An `arm` frame carries the trading-keystore passphrase once
 * (verified and discarded by the daemon, never stored or echoed); every reply carries public facts only (addresses,
 * revisions, caps, the RPC host, the global fee) and never a key, URL, proof or rule text. */
import * as fs from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, isId, isVersion, MAX_FRAME_BYTES, parseAgentState, type RunnerAgentState } from "./protocol.js";
import type { PrivateBrainTarget } from "./private-brain-client.js";
import { isTradingWalletPassphrase } from "./private-trading-keystore-protocol.js";
import { SOCKET_PROOF_CLIENT_TIMEOUT_MS } from "./private-socket-proof.js";
import { isSolanaAddress } from "./solana-base58.js";
import { parsePrivateChangeEntries, type PrivateChangeEntries } from "./private-change-entries.js";
import { parsePrivateCapBasis, parsePrivateCapChoice, parsePrivateCapRequest, parsePrivateCapSetting, parsePrivateSpendRemaining,
  privateCapBasisMatches, privateSpendRemaining, validPrivateCapPair, type PrivateCapBasis, type PrivateCapChoice, type PrivateCapRequest,
  type PrivateCapSetting, type PrivateSpendRemaining } from "./private-spend-cap.js";

/** Daemon-side deadline for precheck (one bounded fee probe), arm (one scrypt passphrase check), limits_quote (one bounded
 * balance read on the owner's RPC) and the owner approval request and poll (a spaced recovery read and create, or one read). */
export const PRIVATE_ARMING_TIMEOUT_MS = 25_000;
const CLIENT_TIMEOUT_MS = 27_000;
const SHORT_TIMEOUT_MS = 3_000;

/** Closed precheck refusals: arming is refused (nothing changes) while any of these holds. */
export const PRIVATE_ARMING_REFUSALS = ["agent_stopped", "agent_paused", "already_armed", "not_paired", "lease_unavailable",
  "wallet_missing", "wallet_locked", "wallet_unbound", "wallet_binding_inactive", "rpc_missing", "rpc_public", "rules_missing",
  "rules_not_executable", "rules_shadow_mode", "stop_loss_missing", "owner_approval_required", "limits_missing",
  "owner_wallet_approval_missing", "owner_approval_unverifiable", "sizing_missing",
  "sizing_slippage_above_bound", "submission_unresolved", "submission_unrelayed", "copy_unacknowledged", "exits_unavailable"] as const;
export type PrivateArmingRefusal = typeof PRIVATE_ARMING_REFUSALS[number];
/** S4 caps: `proposal_missing` (unknown or expired spend cap proposal), `basis_stale` (a percentage fixed too long ago, or
 * a basis that does not reproduce its amount), `balance_unavailable` (the owner's RPC could not read the wallet balance) and
 * `cap_out_of_bounds` (a fixed percentage of zero or above the 10 SOL backstop, or a per-trade amount above the daily one).
 * S6 moment 3: `approval_unavailable` (Balchemy could not be reached for the owner approval) and `approval_mismatch` (Balchemy
 * answered with a challenge or evidence that does not match this runner's own request, or a signature that does not verify
 * against the pinned paired wallet: nothing is stored) and `approval_superseded` (a newer, different approval is already stored, so
 * this one was not used). */
export const PRIVATE_ARMING_CHANNEL_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "unknown_agent",
  "revision_conflict", "version_conflict", "summary_changed", "passphrase_rejected", "clock_rollback", "busy", "cancelled",
  "state_unavailable", "closing", "proposal_missing", "basis_stale", "balance_unavailable", "cap_out_of_bounds",
  "approval_unavailable", "approval_mismatch", "approval_superseded",
  // Owner resume of new entries (`entries_resume`): the agent is not live_armed; its entries are not paused; a change to its rules, caps or
  // sizing is being saved or was not saved, so the runner's own hold keeps them paused (only a saved change lifts it).
  "not_armed", "entries_not_paused", "change_pending",
  // A2a socket proof (private-socket-proof.ts PRIVATE_SOCKET_PROOF_ERRORS; passphrase_rejected, wallet_locked, busy and cancelled are
  // listed above): a raising limits_set or entries_resume without the trading-wallet passphrase, or after too many wrong ones.
  "proof_required", "proof_throttled",
  // A2a owner pin and authority watermark (private-socket-proof.ts PRIVATE_AUTHORITY_ERRORS): no sealed owner pin, a pin that does not
  // verify, a pin that no longer equals the pairing record; the owner-sealed settings are missing or looser than the current ones.
  "owner_pin_missing", "owner_pin_invalid", "owner_pin_mismatch", "authority_unsealed", ...PRIVATE_ARMING_REFUSALS] as const;
export type PrivateArmingChannelError = typeof PRIVATE_ARMING_CHANNEL_ERRORS[number];

export interface PrivateArmingBinding {
  channel: "private_arming"; version: 1; id: string; localProfileId: string; instanceId: string; agentId: string;
}
/** S4: `limits_quote` fixes a requested percentage into lamports from the wallet balance on the owner's RPC (read-only,
 * nothing saved); `limits_proposal` reads one unconfirmed spend cap proposal the chat brain saved (read-only). Only
 * `limits_set`, after the owner's typed confirmation in the CLI, saves caps. */
export type PrivateArmingRequest = PrivateArmingBinding & (
  | { action: "limits_status" }
  /** A2a: `passphrase` (optional) is the trading-wallet socket proof of a raising change; the daemon decides whether it is required. */
  | { action: "limits_set"; expectedRevision: number; perTrade: PrivateCapChoice; daily: PrivateCapChoice;
    perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null; passphrase?: string }
  | { action: "limits_quote"; perTrade: PrivateCapRequest; daily: PrivateCapRequest }
  | { action: "limits_proposal"; proposalId: string }
  /** Cockpit side panel: one read of the trading wallet's SOL balance on the owner's RPC. Read-only; nothing is saved. */
  | { action: "wallet_balance" }
  | { action: "precheck" }
  /** S6 moment 3: open (or recover) the owner's one-time wallet approval for the current trading wallet and caps; then poll it. */
  | { action: "approval_request" }
  | { action: "approval_poll"; challengeId: string }
  | { action: "arm"; expectedVersion: number; summaryDigest: string; passphrase: string }
  /** Owner resume (cockpit `/resume`, typed RESUME <agent>): turns NEW ENTRIES of a live_armed agent whose entries the owner paused back
   * on, at exactly `expectedVersion`. It never arms, never changes caps, rules or exits, and never lifts a hold the runner placed itself
   * (an unsaved settings change, an exits-only arm). */
  | { action: "entries_resume"; expectedVersion: number; passphrase?: string });

/** Revision 0: both caps `unset` and remaining `unset`. A saved revision: both answered (`none` or an amount). */
export interface PrivateSpendLimitsView {
  agentId: string; revision: number; perTrade: PrivateCapSetting; daily: PrivateCapSetting;
  perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null;
  utcDay: string; spentLamports: string; reservedLamports: string; remaining: PrivateSpendRemaining;
}
/** Fixed caps ready for review: what `limits_set` would save. */
export interface PrivateSpendCapQuote { perTrade: PrivateCapChoice; daily: PrivateCapChoice; perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null }
/** An unconfirmed proposal from the chat brain. It never changes caps by itself. */
export interface PrivateSpendCapProposalView { proposalId: string; perTrade: PrivateCapRequest; daily: PrivateCapRequest; createdAt: number; expiresAt: number }
export const PRIVATE_SPEND_CAP_PROPOSAL_ID = /^scp_[0-9a-f]{32}$/;
/** The one global fee from a read-only probe assessment (or unavailable: then the fee is shown at each trade). */
export type PrivateArmingFee = { state: "shown"; rateBps: number; grossInputLamports: string; feeLamports: string } | { state: "unavailable" };
/** Everything the owner confirms. `summaryDigest` binds every field except `fee` (informational) and is re-derived at arm. */
export interface PrivateArmingSummary {
  agentId: string; runtimeVersion: number; mode: "shadow" | "live_unarmed";
  walletAddress: string; walletBindingId: string; rpcHost: string;
  limitsRevision: number; perTrade: PrivateCapChoice; daily: PrivateCapChoice;
  perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null;
  rulesRevisionId: string; stopLossBps: number; takeProfitLevels: number;
  sizingAmountSol: string; sizingAmountLamports: string; sizingSlippageBps: number;
  fee: PrivateArmingFee; summaryDigest: string;
  /** Phase 1 (17 Nov 2026), present only then: a trade from before is still unresolved and no buy of it can be sent again, so arming
   * arms for exits only. New entries stay paused until no unresolved trade remains, then turn on by themselves. Bound by the digest.
   * A2a `authority_unsealed`: the owner-sealed settings (private-authority-seal.ts) are missing or looser than the current ones, so arming
   * arms for exits only as well (open positions keep their stop-loss); new entries stay paused until the owner seals the settings again
   * and resumes them (entries_resume). Shown instead of `submission_unresolved` when both apply. */
  entriesHold?: "submission_unresolved" | "authority_unsealed";
}
/** The Hub link for the owner's wallet approval: public facts only (no secret, nonce or proof). `checkCode` is the LOCAL code,
 * recomputed by this runner from its own request; Hub shows the same code for the same terms. `perTrade` and `daily` are the
 * limits that code approves, printed next to it so the owner compares the terms, not only the code. */
export interface PrivateOwnerApprovalLinkView {
  challengeId: string; checkCode: string; expiresAt: string; frontendOrigin: string; path: string; perTrade: PrivateCapChoice; daily: PrivateCapChoice;
}
export type PrivateOwnerApprovalState = "pending" | "approved" | "expired";
export type PrivateArmingData =
  | { kind: "limits"; limits: PrivateSpendLimitsView }
  /** `entries` only when the agent was armed when the save began (owner decision of 17 Nov 2026, private-change-entries.ts). */
  | { kind: "limits_set"; expectedRevision: number; limits: PrivateSpendLimitsView; entries?: PrivateChangeEntries }
  | { kind: "limits_quote"; quote: PrivateSpendCapQuote }
  | { kind: "limits_proposal"; proposal: PrivateSpendCapProposalView }
  | { kind: "wallet_balance"; walletAddress: string; lamports: string; observedAt: number }
  | { kind: "precheck"; summary: PrivateArmingSummary }
  | { kind: "approval_link"; link: PrivateOwnerApprovalLinkView }
  | { kind: "approval_status"; state: PrivateOwnerApprovalState }
  /** `exitsOnly` (Phase 1): armed with new entries paused until no unresolved trade remains (state.entries is then "paused"). */
  | { kind: "armed"; state: RunnerAgentState; exitsOnly?: true }
  /** `entries_resume` applied: still live_armed and armed, entries enabled, one version later. */
  | { kind: "entries_resumed"; state: RunnerAgentState };
export type PrivateArmingResponse = PrivateArmingBinding & ({ ok: true; data: PrivateArmingData } | { ok: false; error: PrivateArmingChannelError });

const BINDING = ["channel", "version", "id", "localProfileId", "instanceId", "agentId"];
const HEX = /^[0-9a-f]{64}$/;
const U64 = /^(?:0|[1-9][0-9]{0,19})$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SOL = /^(?:0|[1-9][0-9]{0,9})(?:\.[0-9]{1,9})?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
function invalid(): never { throw new Error("Invalid private arming request or response"); }
function exact(value: unknown, keys: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (!keys.every((key) => Object.hasOwn(fields, key))
    || Reflect.ownKeys(value).some((key) => typeof key !== "string" || ![...keys, ...optional].includes(key))
    || Object.values(fields).some((field) => !("value" in field) || !field.enumerable)) invalid();
}
function binding(value: Record<string, unknown>): void {
  if (value.channel !== "private_arming" || value.version !== 1 || ![value.id, value.localProfileId, value.instanceId, value.agentId].every(isId)) invalid();
}
function bounded(value: unknown): void { if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_FRAME_BYTES) invalid(); }
function u64(value: unknown, minimum = 0n): string {
  if (typeof value !== "string" || !U64.test(value) || BigInt(value) < minimum || BigInt(value) > (1n << 64n) - 1n) invalid();
  return value;
}
function count(value: unknown, minimum = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) invalid();
  return value;
}
function host(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9.:[\]-]{1,253}$/.test(value)) invalid();
  return value;
}

function capField<T>(read: () => T): T { try { return read(); } catch { return invalid(); } }
function timestamp(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}
/** Two caps an owner may save: `none` or 1 lamport..10 SOL each; per-trade <= daily when both are amounts. */
export function validPrivateSpendCaps(perTrade: PrivateCapSetting, daily: PrivateCapSetting): boolean { return validPrivateCapPair(perTrade, daily); }
function quote(value: Record<string, unknown>): PrivateSpendCapQuote {
  const perTrade = capField(() => parsePrivateCapChoice(value.perTrade)), daily = capField(() => parsePrivateCapChoice(value.daily));
  const perTradeBasis = capField(() => parsePrivateCapBasis(value.perTradeBasis)), dailyBasis = capField(() => parsePrivateCapBasis(value.dailyBasis));
  if (!validPrivateCapPair(perTrade, daily) || !privateCapBasisMatches(perTrade, perTradeBasis) || !privateCapBasisMatches(daily, dailyBasis)) invalid();
  return { perTrade, daily, perTradeBasis, dailyBasis };
}

export function parsePrivateArmingRequest(value: unknown): PrivateArmingRequest {
  exact(value, [...BINDING, "action"], ["expectedRevision", "perTrade", "daily", "perTradeBasis", "dailyBasis", "proposalId",
    "expectedVersion", "summaryDigest", "passphrase", "challengeId"]);
  binding(value);
  if (value.action === "limits_status" || value.action === "precheck" || value.action === "approval_request" || value.action === "wallet_balance") exact(value, [...BINDING, "action"]);
  else if (value.action === "approval_poll") {
    exact(value, [...BINDING, "action", "challengeId"]);
    if (typeof value.challengeId !== "string" || !UUID.test(value.challengeId)) invalid();
  }
  else if (value.action === "limits_set") {
    exact(value, [...BINDING, "action", "expectedRevision", "perTrade", "daily", "perTradeBasis", "dailyBasis"], ["passphrase"]);
    count(value.expectedRevision);
    if (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase)) invalid();
    const fixed = quote(value);
    bounded(value);
    return Object.freeze({ ...value, ...fixed }) as unknown as PrivateArmingRequest;
  } else if (value.action === "limits_quote") {
    exact(value, [...BINDING, "action", "perTrade", "daily"]);
    const perTrade = capField(() => parsePrivateCapRequest(value.perTrade)), daily = capField(() => parsePrivateCapRequest(value.daily));
    if (perTrade.kind === "lamports" && daily.kind === "lamports" && BigInt(perTrade.lamports) > BigInt(daily.lamports)) invalid();
    bounded(value);
    return Object.freeze({ ...value, perTrade, daily }) as unknown as PrivateArmingRequest;
  } else if (value.action === "limits_proposal") {
    exact(value, [...BINDING, "action", "proposalId"]);
    if (typeof value.proposalId !== "string" || !PRIVATE_SPEND_CAP_PROPOSAL_ID.test(value.proposalId)) invalid();
  } else if (value.action === "entries_resume") {
    exact(value, [...BINDING, "action", "expectedVersion"], ["passphrase"]);
    if (!isVersion(value.expectedVersion) || (Object.hasOwn(value, "passphrase") && !isTradingWalletPassphrase(value.passphrase))) invalid();
  } else if (value.action === "arm") {
    exact(value, [...BINDING, "action", "expectedVersion", "summaryDigest", "passphrase"]);
    if (!isVersion(value.expectedVersion) || typeof value.summaryDigest !== "string" || !HEX.test(value.summaryDigest)
      || !isTradingWalletPassphrase(value.passphrase)) invalid();
  } else invalid();
  bounded(value);
  return Object.freeze({ ...value }) as unknown as PrivateArmingRequest;
}

function limitsView(value: unknown, agentId: string): PrivateSpendLimitsView {
  exact(value, ["agentId", "revision", "perTrade", "daily", "perTradeBasis", "dailyBasis", "utcDay", "spentLamports", "reservedLamports", "remaining"]);
  const revision = count(value.revision);
  if (value.agentId !== agentId || typeof value.utcDay !== "string" || !DAY.test(value.utcDay)) invalid();
  const spent = BigInt(u64(value.spentLamports)), reserved = BigInt(u64(value.reservedLamports));
  const perTrade = capField(() => parsePrivateCapSetting(value.perTrade, { allowUnset: true }));
  const daily = capField(() => parsePrivateCapSetting(value.daily, { allowUnset: true }));
  const perTradeBasis = capField(() => parsePrivateCapBasis(value.perTradeBasis)), dailyBasis = capField(() => parsePrivateCapBasis(value.dailyBasis));
  const remaining = capField(() => parsePrivateSpendRemaining(value.remaining));
  if (revision === 0) {
    if (perTrade.kind !== "unset" || daily.kind !== "unset" || perTradeBasis || dailyBasis || remaining.kind !== "unset") invalid();
  } else {
    if (!validPrivateCapPair(perTrade, daily) || !privateCapBasisMatches(perTrade, perTradeBasis) || !privateCapBasisMatches(daily, dailyBasis)) invalid();
    // The remaining kind follows the daily cap: `none` is unlimited, an amount is at most what the cap leaves.
    const expected = privateSpendRemaining(daily, spent + reserved);
    if (remaining.kind !== expected.kind || (remaining.kind === "lamports" && remaining.lamports !== (expected as { lamports: string }).lamports)) invalid();
  }
  return Object.freeze({ agentId, revision, perTrade, daily, perTradeBasis, dailyBasis, utcDay: value.utcDay, spentLamports: value.spentLamports as string,
    reservedLamports: value.reservedLamports as string, remaining });
}
function proposalView(value: unknown): PrivateSpendCapProposalView {
  exact(value, ["proposalId", "perTrade", "daily", "createdAt", "expiresAt"]);
  if (typeof value.proposalId !== "string" || !PRIVATE_SPEND_CAP_PROPOSAL_ID.test(value.proposalId)) invalid();
  const perTrade = capField(() => parsePrivateCapRequest(value.perTrade)), daily = capField(() => parsePrivateCapRequest(value.daily));
  if (timestamp(value.expiresAt) <= timestamp(value.createdAt)) invalid();
  return Object.freeze({ proposalId: value.proposalId, perTrade, daily, createdAt: value.createdAt as number, expiresAt: value.expiresAt as number });
}
function approvalLink(value: unknown): PrivateOwnerApprovalLinkView {
  exact(value, ["challengeId", "checkCode", "expiresAt", "frontendOrigin", "path", "perTrade", "daily"]);
  const perTrade = capField(() => parsePrivateCapChoice(value.perTrade)), daily = capField(() => parsePrivateCapChoice(value.daily));
  if (!validPrivateCapPair(perTrade, daily)) invalid();
  if (typeof value.challengeId !== "string" || !UUID.test(value.challengeId) || typeof value.checkCode !== "string" || !/^[0-9A-F]{6}$/.test(value.checkCode)
    || typeof value.expiresAt !== "string" || !ISO.test(value.expiresAt) || !Number.isFinite(Date.parse(value.expiresAt))
    || new Date(value.expiresAt).toISOString() !== value.expiresAt || typeof value.frontendOrigin !== "string" || typeof value.path !== "string") invalid();
  let url: URL;
  try { url = new URL(value.frontendOrigin); } catch { return invalid(); }
  if (url.origin !== value.frontendOrigin || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  const path = /^\/hub\/local-agents\/([0-9a-f-]{36})\/approve\/([0-9a-f-]{36})$/.exec(value.path);
  if (!path || !UUID.test(path[1]!) || path[2] !== value.challengeId) invalid();
  return Object.freeze({ challengeId: value.challengeId, checkCode: value.checkCode, expiresAt: value.expiresAt, frontendOrigin: value.frontendOrigin,
    path: value.path, perTrade, daily });
}
function fee(value: unknown): PrivateArmingFee {
  exact(value, ["state"], ["rateBps", "grossInputLamports", "feeLamports"]);
  if (value.state === "unavailable") { exact(value, ["state"]); return Object.freeze({ state: "unavailable" as const }); }
  exact(value, ["state", "rateBps", "grossInputLamports", "feeLamports"]);
  if (value.state !== "shown" || count(value.rateBps) > 10_000) invalid();
  if (BigInt(u64(value.feeLamports)) > BigInt(u64(value.grossInputLamports, 1n))) invalid();
  return Object.freeze({ ...value }) as unknown as PrivateArmingFee;
}
const SUMMARY_KEYS = ["agentId", "runtimeVersion", "mode", "walletAddress", "walletBindingId", "rpcHost", "limitsRevision",
  "perTrade", "daily", "perTradeBasis", "dailyBasis", "rulesRevisionId", "stopLossBps", "takeProfitLevels", "sizingAmountSol",
  "sizingAmountLamports", "sizingSlippageBps", "fee", "summaryDigest"] as const;
export function parsePrivateArmingSummary(value: unknown, agentId: string): PrivateArmingSummary {
  exact(value, SUMMARY_KEYS, ["entriesHold"]);
  if (Object.hasOwn(value, "entriesHold") && value.entriesHold !== "submission_unresolved" && value.entriesHold !== "authority_unsealed") invalid();
  if (value.agentId !== agentId || !isVersion(value.runtimeVersion) || (value.mode !== "shadow" && value.mode !== "live_unarmed")
    || !isSolanaAddress(value.walletAddress) || !isId(value.walletBindingId) || count(value.limitsRevision, 1) < 1
    || typeof value.rulesRevisionId !== "string" || !/^brr_[A-Za-z0-9_-]{1,120}$/.test(value.rulesRevisionId)
    || count(value.stopLossBps, 1) > 10_000 || count(value.takeProfitLevels) > 64
    || typeof value.sizingAmountSol !== "string" || !SOL.test(value.sizingAmountSol)
    || count(value.sizingSlippageBps, 1) > 10_000 || typeof value.summaryDigest !== "string" || !HEX.test(value.summaryDigest)) invalid();
  u64(value.sizingAmountLamports, 1n); host(value.rpcHost);
  // A summary exists only for answered caps: `unset` never reaches it (arming refuses limits_missing first).
  const caps = quote(value);
  return Object.freeze({ ...value, ...caps, fee: fee(value.fee) }) as unknown as PrivateArmingSummary;
}

export function parsePrivateArmingResponse(value: unknown): PrivateArmingResponse {
  exact(value, [...BINDING, "ok"], ["data", "error"]); binding(value);
  const agentId = value.agentId as string;
  if (value.ok === true) {
    exact(value, [...BINDING, "ok", "data"]);
    const data = value.data;
    exact(data, ["kind"], ["limits", "expectedRevision", "summary", "state", "quote", "proposal", "link", "walletAddress", "lamports", "observedAt", "entries",
      "exitsOnly"]);
    let parsed: PrivateArmingData;
    if (data.kind === "limits") { exact(data, ["kind", "limits"]); parsed = { kind: "limits", limits: limitsView(data.limits, agentId) }; }
    else if (data.kind === "limits_set") {
      exact(data, ["kind", "expectedRevision", "limits"], ["entries"]);
      const limits = limitsView(data.limits, agentId);
      if (limits.revision !== count(data.expectedRevision) + 1) invalid();
      const rawEntries: unknown = data.entries;
      const entries = Object.hasOwn(data, "entries") ? capField(() => parsePrivateChangeEntries(rawEntries)) : undefined;
      parsed = { kind: "limits_set", expectedRevision: data.expectedRevision as number, limits, ...(entries ? { entries } : {}) };
    } else if (data.kind === "limits_quote") {
      exact(data, ["kind", "quote"]); exact(data.quote, ["perTrade", "daily", "perTradeBasis", "dailyBasis"]);
      parsed = { kind: "limits_quote", quote: Object.freeze(quote(data.quote)) };
    } else if (data.kind === "wallet_balance") {
      exact(data, ["kind", "walletAddress", "lamports", "observedAt"]);
      if (typeof data.walletAddress !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(data.walletAddress)
        || !Number.isSafeInteger(data.observedAt) || (data.observedAt as number) < 0) invalid();
      u64(data.lamports);
      parsed = { kind: "wallet_balance", walletAddress: data.walletAddress, lamports: data.lamports as string, observedAt: data.observedAt as number };
    } else if (data.kind === "limits_proposal") { exact(data, ["kind", "proposal"]); parsed = { kind: "limits_proposal", proposal: proposalView(data.proposal) }; } else if (data.kind === "precheck") { exact(data, ["kind", "summary"]); parsed = { kind: "precheck", summary: parsePrivateArmingSummary(data.summary, agentId) }; }
    else if (data.kind === "approval_link") { exact(data, ["kind", "link"]); parsed = { kind: "approval_link", link: approvalLink(data.link) }; }
    else if (data.kind === "approval_status") {
      exact(data, ["kind", "state"]);
      if (data.state !== "pending" && data.state !== "approved" && data.state !== "expired") invalid();
      parsed = { kind: "approval_status", state: data.state };
    } else if (data.kind === "armed") {
      exact(data, ["kind", "state"], ["exitsOnly"]);
      const state = parseAgentState(data.state);
      const exitsOnly = Object.hasOwn(data, "exitsOnly");
      if ((exitsOnly && data.exitsOnly !== true) || state.agentId !== agentId || state.mode !== "live_armed"
        || state.entries !== (exitsOnly ? "paused" : "enabled")) invalid();
      parsed = { kind: "armed", state: Object.freeze({ ...state }), ...(exitsOnly ? { exitsOnly: true as const } : {}) };
    } else if (data.kind === "entries_resumed") {
      exact(data, ["kind", "state"]);
      const state = parseAgentState(data.state);
      if (state.agentId !== agentId || state.mode !== "live_armed" || state.armed !== true || state.lifecycle !== "idle" || state.entries !== "enabled") invalid();
      parsed = { kind: "entries_resumed", state: Object.freeze({ ...state }) };
    } else invalid();
    bounded(value);
    return Object.freeze({ channel: "private_arming", version: 1, id: value.id, localProfileId: value.localProfileId, instanceId: value.instanceId,
      agentId, ok: true, data: Object.freeze(parsed) }) as PrivateArmingResponse;
  }
  if (value.ok !== false) invalid();
  exact(value, [...BINDING, "ok", "error"]);
  if (!PRIVATE_ARMING_CHANNEL_ERRORS.includes(value.error as PrivateArmingChannelError)) invalid();
  bounded(value);
  return Object.freeze({ ...value }) as unknown as PrivateArmingResponse;
}
function responseBinding(request: PrivateArmingRequest): PrivateArmingBinding {
  return { channel: "private_arming", version: 1, id: request.id, localProfileId: request.localProfileId, instanceId: request.instanceId, agentId: request.agentId };
}
export function privateArmingSuccess(request: PrivateArmingRequest, data: PrivateArmingData): PrivateArmingResponse {
  return parsePrivateArmingResponse({ ...responseBinding(request), ok: true, data });
}
export function privateArmingFailure(request: PrivateArmingRequest, error: PrivateArmingChannelError): PrivateArmingResponse {
  return parsePrivateArmingResponse({ ...responseBinding(request), ok: false, error });
}
/** The reply must answer exactly this request: same binding, the matching kind, and for `arm` the CAS'd next version. */
export function validatePrivateArmingReply(request: PrivateArmingRequest, value: unknown): PrivateArmingResponse {
  const response = parsePrivateArmingResponse(value);
  if (response.id !== request.id || response.localProfileId !== request.localProfileId
    || response.instanceId !== request.instanceId || response.agentId !== request.agentId) invalid();
  if (response.ok) {
    const kind = response.data.kind;
    if ((request.action === "limits_status" && kind !== "limits") || (request.action === "precheck" && kind !== "precheck")
      || (request.action === "wallet_balance") !== (kind === "wallet_balance")
      || (request.action === "limits_proposal" && (response.data.kind !== "limits_proposal" || response.data.proposal.proposalId !== request.proposalId))) invalid();
    if (request.action === "limits_set" && (response.data.kind !== "limits_set" || response.data.expectedRevision !== request.expectedRevision
      || JSON.stringify(capsOf(response.data.limits)) !== JSON.stringify(capsOf(request)))) invalid();
    if (request.action === "limits_quote") {
      if (response.data.kind !== "limits_quote") invalid();
      const fixed = response.data.quote;
      // An amount or `none` comes back unchanged; a percentage comes back as an amount with the same percentage basis.
      const agrees = (asked: PrivateCapRequest, got: PrivateCapChoice, basis: PrivateCapBasis | null): boolean => asked.kind === "percent"
        ? got.kind === "lamports" && basis?.percentBps === asked.percentBps : basis === null && JSON.stringify(asked) === JSON.stringify(got);
      if (!agrees(request.perTrade, fixed.perTrade, fixed.perTradeBasis) || !agrees(request.daily, fixed.daily, fixed.dailyBasis)) invalid();
    }
    // An exits-only arm also holds entries in the same step (arm, then holdEntries), so its state is two versions ahead.
    if (request.action === "arm" && (response.data.kind !== "armed"
      || response.data.state.version !== request.expectedVersion + (response.data.exitsOnly === true ? 2 : 1))) invalid();
    // A request answers with a link, or approved when a stored approval was recovered; a poll answers with a status only.
    if (request.action === "approval_request" && response.data.kind !== "approval_link"
      && !(response.data.kind === "approval_status" && response.data.state === "approved")) invalid();
    if (request.action === "approval_poll" && response.data.kind !== "approval_status") invalid();
    // An owner entries resume answers with exactly the released state: the CAS'd next version, never another kind.
    if ((request.action === "entries_resume") !== (response.data.kind === "entries_resumed")) invalid();
    if (request.action === "entries_resume" && (response.data.kind !== "entries_resumed" || response.data.state.version !== request.expectedVersion + 1)) invalid();
    if (request.action !== "approval_request" && response.data.kind === "approval_link") invalid();
    if (request.action !== "approval_request" && request.action !== "approval_poll" && response.data.kind === "approval_status") invalid();
  }
  return response;
}

function capsOf(value: { perTrade: PrivateCapSetting; daily: PrivateCapSetting; perTradeBasis: PrivateCapBasis | null; dailyBasis: PrivateCapBasis | null }): unknown[] {
  return [value.perTrade, value.daily, value.perTradeBasis, value.dailyBasis];
}

export class PrivateArmingTransportError extends Error {
  constructor(readonly code: "connection_unavailable" | "outcome_unknown") { super(`Local arming ${code}`); this.name = "PrivateArmingTransportError"; }
}
export type PrivateArmingTransport = (socketPath: string, request: PrivateArmingRequest) => Promise<PrivateArmingResponse>;
export function privateArmingBinding(target: PrivateBrainTarget): PrivateArmingBinding {
  return { channel: "private_arming", version: 1, id: randomUUID(), localProfileId: target.localProfileId, instanceId: target.instanceId, agentId: target.agentId };
}
/** One bounded owner-socket exchange. A lost `arm`, `limits_set` or `entries_resume` reply is unknown and never retried. */
export async function requestPrivateArming(socketPath: string, input: PrivateArmingRequest): Promise<PrivateArmingResponse> {
  const request = parsePrivateArmingRequest(input);
  const mutation = request.action === "arm" || request.action === "limits_set" || request.action === "entries_resume";
  try {
    const directory = fs.lstatSync(path.dirname(socketPath)); const socket = fs.lstatSync(socketPath);
    if (directory.isSymbolicLink() || !directory.isDirectory() || socket.isSymbolicLink() || !socket.isSocket()
      || (directory.mode & 0o077) !== 0 || (socket.mode & 0o077) !== 0
      || (process.getuid && (directory.uid !== process.getuid() || socket.uid !== process.getuid()))) throw new Error("Unsafe socket");
  } catch { throw new PrivateArmingTransportError("connection_unavailable"); }
  return new Promise<PrivateArmingResponse>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath }); const reader = new FrameReader();
    let sent = false; let settled = false;
    const fail = (): void => {
      if (settled) return; settled = true; clearTimeout(deadline); socket.destroy();
      reject(new PrivateArmingTransportError(sent && mutation ? "outcome_unknown" : "connection_unavailable"));
    };
    const deadline = setTimeout(fail, request.action === "arm" || request.action === "precheck" || request.action === "limits_quote" || request.action === "wallet_balance"
      || request.action === "approval_request" || request.action === "approval_poll" ? CLIENT_TIMEOUT_MS
      // A2a: a frame that carries the socket proof waits for the daemon's proof deadline (one serialized scrypt).
      : Object.hasOwn(request, "passphrase") ? SOCKET_PROOF_CLIENT_TIMEOUT_MS : SHORT_TIMEOUT_MS);
    socket.once("close", fail); socket.on("error", fail);
    socket.on("connect", () => { sent = true; socket.end(encodeFrame(request)); });
    socket.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { fail(); } });
    socket.on("end", () => {
      if (settled) return;
      try {
        const response = validatePrivateArmingReply(request, reader.finish());
        settled = true; clearTimeout(deadline); socket.destroy(); resolve(response);
      } catch { fail(); }
    });
  });
}
