/** M3.2 S6 moment 3 ("first enable on this computer", design section 4): the runner's own record of the owner's wallet approval.
 *
 * Neither side trusts the other. Balchemy opens a challenge (runner-signed create), the owner signs it in Hub with the PAIRED
 * wallet, Balchemy verifies and stores the evidence, and this runner then fetches the evidence (runner-signed read) and verifies
 * it itself: it re-derives the exact message from its OWN facts (the pinned pairing record's agent, binding digest, runner key,
 * frontend origin, paired wallet and chain id, plus its own profile, active trading-wallet binding and requested caps) and checks
 * the Ed25519 signature against the pinned paired wallet. A backend alone can never approve. Only verified records are stored, and
 * every coverage check re-verifies the stored record against the current own facts (so a restart needs no network, and a tampered
 * file can never cover anything). A Base-paired owner cannot be verified by the runner yet: `owner_approval_unverifiable`
 * (owner decision 58), never an approval.
 *
 * Coverage (design section 5, owner decisions 26-37): a signed `none` covers any current cap; a signed amount covers a current
 * amount at or below it; a current `none` is never covered by a signed amount. Only the newest approval per (agent, binding
 * digest, runner key, trading-wallet binding id, trading address) is kept, matching the backend gate's "latest wins". Nothing
 * here arms, signs a transaction or moves funds. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { AgentSdkError, RUNNER_OWNER_APPROVAL_CHAIN_IDS, runnerFirstEnableApprovalMessage, runnerFirstEnableChallengeCheckCode, runnerFirstEnableFields,
  runnerFirstEnableLocalCheckCode,
  RunnerOwnerApprovalClient, type RunnerCapBasis, type RunnerFirstEnableCaps, type RunnerFirstEnableChallenge, type RunnerFirstEnableExpectedTarget,
  type RunnerFirstEnableFields, type RunnerFirstEnableReadRequest, type RunnerFirstEnableReadResponse, type RunnerFirstEnableRequest,
  type RunnerFirstEnableUnverifiedEvidence, type RunnerOwnerApprovalChainId, type RunnerSignableCap } from "@balchemyai/agent-sdk";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { signRunnerFirstEnableProof, signRunnerFirstEnableReadProof, type PairingOwnerApprovalIdentity } from "./pairing-identity.js";
import { isId, isRecord } from "./protocol.js";
import { decodeBase58, encodeBase58, isSolanaAddress } from "./solana-base58.js";
import type { PrivateCapBasis, PrivateCapChoice } from "./private-spend-cap.js";
import type { RunnerRuntimeActiveLease } from "./runtime-bridge.js";
import { addRunnerAgent } from "./agent-roster.js";

export type PrivateOwnerApprovalCoverage = "covered" | "owner_wallet_approval_missing" | "owner_approval_unverifiable";
export type PrivateOwnerApprovalErrorCode = "approval_unavailable" | "approval_mismatch" | "approval_superseded" | "owner_approval_unverifiable"
  | "lease_unavailable" | "state_unavailable" | "cancelled";
export class PrivateOwnerApprovalError extends Error {
  /** `status`: Balchemy's HTTP status when it refused (409 approval_stale, 429 rate limit or too many open challenges); only the K2
   * ceiling worker reads it. The closed `code` stays what arming forwards. */
  constructor(readonly code: PrivateOwnerApprovalErrorCode, readonly status?: number) { super(`Owner approval ${code}`); this.name = "PrivateOwnerApprovalError"; }
}
function fail(code: PrivateOwnerApprovalErrorCode = "state_unavailable", status?: number): never { throw new PrivateOwnerApprovalError(code, status); }

/** The current caps the approval must cover (never `unset`: arming refuses limits_missing first). */
export interface PrivateOwnerApprovalCaps { perTrade: PrivateCapChoice; daily: PrivateCapChoice }
/** The agent's active trading-wallet binding as the arming prechecks read it. */
export interface PrivateOwnerApprovalBinding { walletBindingId: string; tradingWalletAddress: string }
/** K2 one-visit setup: the owner's proposed spend ceiling, both caps as canonical lamport strings (never `none`). */
export interface PrivateOwnerApprovalCeiling { perTradeLamports: string; dailyLamports: string }
const LAMPORTS = /^[1-9][0-9]{0,19}$/;
/** The ceiling as current-cap choices; anything but two positive lamport amounts with perTrade <= daily is refused before any request. */
function ceilingCaps(ceiling: PrivateOwnerApprovalCeiling): PrivateOwnerApprovalCaps {
  if (!isRecord(ceiling) || !exactKeys(ceiling, ["perTradeLamports", "dailyLamports"]) || typeof ceiling.perTradeLamports !== "string"
    || typeof ceiling.dailyLamports !== "string" || !LAMPORTS.test(ceiling.perTradeLamports) || !LAMPORTS.test(ceiling.dailyLamports)
    || BigInt(ceiling.perTradeLamports) > BigInt(ceiling.dailyLamports)) fail("approval_mismatch");
  return { perTrade: { kind: "lamports", lamports: ceiling.perTradeLamports }, daily: { kind: "lamports", lamports: ceiling.dailyLamports } };
}
/** The canonical signable fields of a ceiling (basis `fixed`); anything the SDK refuses is a mismatch, never a request. */
function ceilingFields(facts: PrivateOwnerApprovalFacts, current: PrivateOwnerApprovalCaps): Readonly<RunnerFirstEnableFields> {
  try { return runnerFirstEnableFields(fieldsOf(facts, privateOwnerApprovalCaps(current, "fixed"))); } catch { return fail("approval_mismatch"); }
}
/** Everything an approval is checked against: only the runner's own facts. */
export interface PrivateOwnerApprovalFacts extends PrivateOwnerApprovalBinding { localProfileId: string; identity: PairingOwnerApprovalIdentity }
/** The signed message inputs of one approval. */
export interface PrivateOwnerApprovalSigned {
  approvalId: string; approvedAt: string; nonce: string; issuedAt: string; expiresAt: string; caps: RunnerFirstEnableCaps; signature: string;
}
/** One verified approval as stored, keyed by (serverAgentId, bindingDigest, runnerPublicKey, walletBindingId, tradingWalletAddress). */
export interface PrivateOwnerApprovalRecord extends PrivateOwnerApprovalSigned {
  serverAgentId: string; bindingDigest: string; runnerPublicKey: string; walletBindingId: string; tradingWalletAddress: string;
}
/** One challenge this runner opened (its own request plus the challenge's nonce and times), kept durably so that a poll is bound
 * to exactly this challenge and a recovery after a restart only accepts terms this runner asked for. */
export interface PrivateOwnerApprovalRequestRecord {
  serverAgentId: string; bindingDigest: string; runnerPublicKey: string; walletBindingId: string; tradingWalletAddress: string;
  challengeId: string; nonce: string; issuedAt: string; expiresAt: string; caps: RunnerFirstEnableCaps;
}
interface Snapshot { schemaVersion: 1; localProfileId: string; agentId: string; records: PrivateOwnerApprovalRecord[]; requests: PrivateOwnerApprovalRequestRecord[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const RUNNER_KEY = /^[A-Za-z0-9+/]{43}=$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_RECORDS = 16;
const MAX_REQUESTS = 8;
const MAX_SNAPSHOT_BYTES = 32 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** Balchemy spaces a create 6 s and a read 2 s apart per agent (local-agent-first-enable.service.ts); a margin covers clock rates. */
export const PRIVATE_OWNER_APPROVAL_CREATE_SPACING_MS = 6_250;
export const PRIVATE_OWNER_APPROVAL_READ_SPACING_MS = 2_250;
const RECOVERY_READ_TIMEOUT_MS = 6_000;
const CREATE_TIMEOUT_MS = 8_000;
const POLL_TIMEOUT_MS = 8_000;
const CLOCK_SKEW_MS = 30_000;

function iso(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key)) && own.every((key) => typeof key === "string");
}
/** Strict canonical base58: exactly 64 bytes that re-encode to the same text. */
function canonicalSignature(value: unknown): Buffer | undefined {
  const bytes = decodeBase58(value, 64);
  return bytes && encodeBase58(bytes) === value ? bytes : undefined;
}
function chainId(value: string): RunnerOwnerApprovalChainId | undefined {
  return (RUNNER_OWNER_APPROVAL_CHAIN_IDS as readonly string[]).includes(value) ? value as RunnerOwnerApprovalChainId : undefined;
}
function sameCaps(a: RunnerFirstEnableCaps, b: RunnerFirstEnableCaps): boolean { return JSON.stringify(a) === JSON.stringify(b); }
/** Exactly the same limits (lamports equal, or none and none); the display-only basis is not compared. */
export function privateOwnerApprovalCapsEqual(signed: Pick<RunnerFirstEnableCaps, "perTrade" | "daily">, current: PrivateOwnerApprovalCaps): boolean {
  const same = (cap: RunnerSignableCap, now: PrivateCapChoice): boolean => cap.kind === "none" ? now.kind === "none"
    : now.kind === "lamports" && BigInt(now.lamports) === BigInt(cap.lamports);
  return same(signed.perTrade, current.perTrade) && same(signed.daily, current.daily);
}

/** A runner percentage basis as the signed (display-only) basis: the daily one, else the per-trade one, else `fixed` (S6 answer 4). */
export function privateOwnerApprovalBasis(perTradeBasis: PrivateCapBasis | null, dailyBasis: PrivateCapBasis | null): RunnerCapBasis {
  const basis = dailyBasis ?? perTradeBasis;
  return basis ? { percentBps: basis.percentBps, balanceLamports: basis.balanceLamports, observedAt: new Date(basis.observedAt).toISOString() } : "fixed";
}
/** The signable caps for the current answers (same shape as the backend's SignableCapSetting). */
export function privateOwnerApprovalCaps(current: PrivateOwnerApprovalCaps, basis: RunnerCapBasis): RunnerFirstEnableCaps {
  const cap = (value: PrivateCapChoice): RunnerSignableCap => value.kind === "none" ? { kind: "none" } : { kind: "lamports", lamports: value.lamports };
  return { perTrade: cap(current.perTrade), daily: cap(current.daily), basis };
}
/** Current caps <= signed caps, compared in lamports only (the basis is display-only). */
export function privateOwnerApprovalCapsCovered(signed: Pick<RunnerFirstEnableCaps, "perTrade" | "daily">, current: PrivateOwnerApprovalCaps): boolean {
  const within = (cap: RunnerSignableCap, now: PrivateCapChoice): boolean =>
    cap.kind === "none" || (now.kind === "lamports" && BigInt(now.lamports) <= BigInt(cap.lamports));
  return within(signed.perTrade, current.perTrade) && within(signed.daily, current.daily);
}
function fieldsOf(facts: PrivateOwnerApprovalFacts, caps: RunnerFirstEnableCaps): RunnerFirstEnableFields {
  return { localProfileId: facts.localProfileId, tradingWalletAddress: facts.tradingWalletAddress, walletBindingId: facts.walletBindingId, caps };
}

/**
 * Verifies one approval against the runner's OWN facts: the message is re-derived from the facts plus the signed message inputs
 * (nonce, times, caps), with the chain id from the pinned pairing record, and the signature must be strict canonical base58 by the
 * pinned paired Solana wallet. `unverifiable`: a Base-paired owner or a pairing chain id outside the Solana set (fail closed).
 */
export function verifyPrivateOwnerApproval(facts: PrivateOwnerApprovalFacts, signed: PrivateOwnerApprovalSigned): "verified" | "invalid" | "unverifiable" {
  const identity = facts.identity;
  if (identity.pairedWallet.chain !== "solana") return "unverifiable";
  const chain = chainId(identity.chainId);
  if (!chain) return "unverifiable";
  try {
    if (!iso(signed.approvedAt) || !iso(signed.issuedAt) || !iso(signed.expiresAt) || !UUID.test(signed.approvalId)) return "invalid";
    const approved = Date.parse(signed.approvedAt);
    if (approved < Date.parse(signed.issuedAt) || approved >= Date.parse(signed.expiresAt)) return "invalid";
    const signature = canonicalSignature(signed.signature);
    const owner = decodeBase58(identity.pairedWallet.address, 32);
    if (!signature || !owner || !isSolanaAddress(identity.pairedWallet.address)) return "invalid";
    const message = runnerFirstEnableApprovalMessage({ frontendOrigin: identity.frontendOrigin, agentId: identity.agentId,
      bindingDigest: identity.bindingDigest, runnerPublicKey: identity.runnerPublicKey,
      pairedWallet: { chain: "solana", address: identity.pairedWallet.address }, chainId: chain, nonce: signed.nonce, issuedAt: signed.issuedAt,
      expiresAt: signed.expiresAt, fields: fieldsOf(facts, signed.caps) });
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, owner]), format: "der", type: "spki" });
    return verifySignature(null, Buffer.from(message, "utf8"), key, signature) ? "verified" : "invalid";
  } catch { return "invalid"; }
}

/**
 * Turns UNVERIFIED backend evidence into a verified record, or refuses. The evidence must name this runner's paired wallet,
 * runner key, profile, trading-wallet binding and address. With `requested` (polling a challenge this runner opened), its action
 * fields must deep-equal the runner's own request, and the signature is checked over the message re-derived from the runner's OWN
 * requested caps (never the evidence's). Without it (recovery of the latest approval), the evidence caps are checked as signed.
 */
export function acceptPrivateOwnerApproval(facts: PrivateOwnerApprovalFacts, evidence: RunnerFirstEnableUnverifiedEvidence,
  requested?: RunnerFirstEnableFields): { verification: "verified"; record: PrivateOwnerApprovalRecord } | { verification: "invalid" | "unverifiable" } {
  const identity = facts.identity;
  if (identity.pairedWallet.chain !== "solana" || !chainId(identity.chainId)) return { verification: "unverifiable" };
  let fields: Readonly<RunnerFirstEnableFields>;
  try { fields = runnerFirstEnableFields(evidence.actionFields); } catch { return { verification: "invalid" }; }
  if (evidence.walletChain !== "solana" || evidence.walletAddress !== identity.pairedWallet.address || evidence.runnerPublicKey !== identity.runnerPublicKey
    || fields.localProfileId !== facts.localProfileId || fields.walletBindingId !== facts.walletBindingId
    || fields.tradingWalletAddress !== facts.tradingWalletAddress) return { verification: "invalid" };
  let caps = fields.caps;
  if (requested) {
    let own: Readonly<RunnerFirstEnableFields>;
    try { own = runnerFirstEnableFields(requested); } catch { return { verification: "invalid" }; }
    if (JSON.stringify(own) !== JSON.stringify(fields)) return { verification: "invalid" };
    caps = own.caps;
  }
  const signed: PrivateOwnerApprovalSigned = { approvalId: evidence.approvalId, approvedAt: evidence.approvedAt, nonce: evidence.nonce,
    issuedAt: evidence.issuedAt, expiresAt: evidence.expiresAt, caps: structuredClone(caps) as RunnerFirstEnableCaps, signature: evidence.signature };
  const verification = verifyPrivateOwnerApproval(facts, signed);
  if (verification === "invalid") {
    // Signed for another Solana network than the one the owner paired on (Balchemy's SOLANA_CHAIN_ID differs from the pairing
    // record): never accepted, but reported as unverifiable rather than as a forgery.
    const otherNetwork = RUNNER_OWNER_APPROVAL_CHAIN_IDS.some((other) => other !== identity.chainId
      && verifyPrivateOwnerApproval({ ...facts, identity: { ...identity, chainId: other } }, signed) === "verified");
    return { verification: otherNetwork ? "unverifiable" : "invalid" };
  }
  if (verification !== "verified") return { verification };
  return { verification, record: { serverAgentId: identity.agentId, bindingDigest: identity.bindingDigest, runnerPublicKey: identity.runnerPublicKey,
    walletBindingId: facts.walletBindingId, tradingWalletAddress: facts.tradingWalletAddress, ...signed } };
}

/** The binding key fields plus the signed caps, shared by stored records and requests. */
function parseKeyAndCaps(r: Record<string, unknown>): Pick<PrivateOwnerApprovalRecord, "serverAgentId" | "bindingDigest" | "runnerPublicKey" | "walletBindingId"
  | "tradingWalletAddress" | "caps"> {
  if (typeof r.serverAgentId !== "string" || !UUID.test(r.serverAgentId) || typeof r.bindingDigest !== "string" || !HEX.test(r.bindingDigest)
    || typeof r.runnerPublicKey !== "string" || !RUNNER_KEY.test(r.runnerPublicKey) || typeof r.walletBindingId !== "string" || !UUID.test(r.walletBindingId)
    || !isSolanaAddress(r.tradingWalletAddress)) fail();
  let caps: RunnerFirstEnableCaps;
  try {
    caps = runnerFirstEnableFields({ localProfileId: "profile", tradingWalletAddress: r.tradingWalletAddress, walletBindingId: r.walletBindingId, caps: r.caps }).caps;
  } catch { return fail(); }
  if (!sameCaps(caps, r.caps as RunnerFirstEnableCaps)) fail();
  return { serverAgentId: r.serverAgentId as string, bindingDigest: r.bindingDigest as string, runnerPublicKey: r.runnerPublicKey as string,
    walletBindingId: r.walletBindingId as string, tradingWalletAddress: r.tradingWalletAddress as string, caps: structuredClone(caps) as RunnerFirstEnableCaps };
}
function parseRecord(value: unknown): PrivateOwnerApprovalRecord {
  const keys = ["serverAgentId", "bindingDigest", "runnerPublicKey", "walletBindingId", "tradingWalletAddress", "approvalId", "approvedAt", "nonce",
    "issuedAt", "expiresAt", "caps", "signature"] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) fail();
  const r = value;
  if (typeof r.approvalId !== "string" || !UUID.test(r.approvalId) || !iso(r.approvedAt) || typeof r.nonce !== "string" || !HEX.test(r.nonce)
    || !iso(r.issuedAt) || !iso(r.expiresAt) || !canonicalSignature(r.signature)) fail();
  return { ...parseKeyAndCaps(r), approvalId: r.approvalId as string, approvedAt: r.approvedAt as string, nonce: r.nonce as string,
    issuedAt: r.issuedAt as string, expiresAt: r.expiresAt as string, signature: r.signature as string };
}
function parseRequest(value: unknown): PrivateOwnerApprovalRequestRecord {
  const keys = ["serverAgentId", "bindingDigest", "runnerPublicKey", "walletBindingId", "tradingWalletAddress", "challengeId", "nonce", "issuedAt",
    "expiresAt", "caps"] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) fail();
  const r = value;
  if (typeof r.challengeId !== "string" || !UUID.test(r.challengeId) || typeof r.nonce !== "string" || !HEX.test(r.nonce) || !iso(r.issuedAt)
    || !iso(r.expiresAt) || Date.parse(r.expiresAt as string) - Date.parse(r.issuedAt as string) !== 10 * 60_000) fail();
  return { ...parseKeyAndCaps(r), challengeId: r.challengeId as string, nonce: r.nonce as string, issuedAt: r.issuedAt as string,
    expiresAt: r.expiresAt as string };
}
const recordKey = (r: Pick<PrivateOwnerApprovalRecord, "serverAgentId" | "bindingDigest" | "runnerPublicKey" | "walletBindingId" | "tradingWalletAddress">): string =>
  JSON.stringify([r.serverAgentId, r.bindingDigest, r.runnerPublicKey, r.walletBindingId, r.tradingWalletAddress]);
function parseSnapshot(value: unknown, scope: { localProfileId: string; agentId: string }): Snapshot {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "agentId", "records", "requests"]) || value.schemaVersion !== 1
    || value.localProfileId !== scope.localProfileId || value.agentId !== scope.agentId || !Array.isArray(value.records)
    || value.records.length > MAX_RECORDS || !Array.isArray(value.requests) || value.requests.length > MAX_REQUESTS) fail();
  const records = value.records.map(parseRecord);
  const requests = value.requests.map(parseRequest);
  if (new Set(records.map(recordKey)).size !== records.length || new Set(requests.map((item) => item.challengeId)).size !== requests.length) fail();
  return { schemaVersion: 1, localProfileId: scope.localProfileId, agentId: scope.agentId, records, requests };
}
export function privateOwnerApprovalFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `owner-approvals-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}

/** The network half: one bounded, lease-fenced create or read for the adopted identity. Tests substitute it. */
export interface PrivateOwnerApprovalTransport {
  create(agentId: string, identity: PairingOwnerApprovalIdentity, request: RunnerFirstEnableRequest, signal: AbortSignal | undefined, timeoutMs: number):
    Promise<{ challenge: Readonly<RunnerFirstEnableChallenge>; expected: RunnerFirstEnableExpectedTarget }>;
  read(agentId: string, identity: PairingOwnerApprovalIdentity, request: RunnerFirstEnableReadRequest, signal: AbortSignal | undefined, timeoutMs: number):
    Promise<Readonly<RunnerFirstEnableReadResponse>>;
}
export interface PrivateOwnerApprovalTransportOptions {
  directory: string; localProfileId: string; instanceId: string;
  readLease(agentId: string): Readonly<RunnerRuntimeActiveLease> | undefined;
  fetchFn?: typeof fetch; monotonicNow?: () => number;
}
const leaseIdentity = (value: { frontendOrigin: string; agentId: string; bindingDigest: string; runnerPublicKey: string }): string =>
  JSON.stringify([value.frontendOrigin, value.agentId, value.bindingDigest, value.runnerPublicKey]);

/** The production transport: the current runner lease pins the target and epoch; the lease must be this pairing's and must not
 * change (or run out) between the first check and the answer (the `queryPrivateAssessmentReceipt` fence). */
export function privateOwnerApprovalTransport(options: PrivateOwnerApprovalTransportOptions): PrivateOwnerApprovalTransport {
  const fenced = async <T>(agentId: string, identity: PairingOwnerApprovalIdentity, signal: AbortSignal | undefined, timeoutMs: number,
    body: (client: RunnerOwnerApprovalClient, lease: Readonly<RunnerRuntimeActiveLease>, abort: AbortSignal) => Promise<T>): Promise<T> => {
    const now = options.monotonicNow ?? (() => performance.now());
    const initial = options.readLease(agentId);
    if (!initial || initial.instanceId !== options.instanceId || !Number.isSafeInteger(initial.epoch) || initial.epoch < 1
      || !Number.isFinite(initial.remainingMs) || initial.remainingMs <= 0 || leaseIdentity(initial) !== leaseIdentity(identity)) fail("lease_unavailable");
    const pinned = JSON.stringify([leaseIdentity(initial), initial.instanceId, initial.epoch]);
    const timeout = Math.min(Math.floor(initial.remainingMs), Math.floor(timeoutMs));
    const started = now();
    if (!(timeout >= 1) || !Number.isFinite(started)) fail("lease_unavailable");
    const controller = new AbortController(); const abort = (): void => controller.abort();
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout); timer.unref();
    const leaseHeld = (): boolean => {
      const lease = options.readLease(agentId);
      return !!lease && JSON.stringify([leaseIdentity(lease), lease.instanceId, lease.epoch]) === pinned && Number.isFinite(lease.remainingMs) && lease.remainingMs > 0;
    };
    // A lease change (or expiry, or the deadline) is a transient connection fact, never a mismatch: fail closed as lease_unavailable.
    const fence = (): void => {
      const current = now();
      if (signal?.aborted) fail("cancelled");
      if (controller.signal.aborted || !leaseHeld() || !Number.isFinite(current) || current < started || current >= started + timeout) fail("lease_unavailable");
    };
    let signerFailed = false;
    const fencedSigner = <R>(sign: () => R): R => { try { fence(); return sign(); } catch (error: unknown) { signerFailed = true; throw error; } };
    const scope = { directory: options.directory, localProfileId: options.localProfileId, agentId };
    try {
      fence();
      const client = new RunnerOwnerApprovalClient({ frontendOrigin: initial.frontendOrigin, agentId: initial.agentId, bindingDigest: initial.bindingDigest,
        runnerPublicKey: initial.runnerPublicKey, instanceId: initial.instanceId, apiBaseUrl: `${initial.frontendOrigin}/api`, timeoutMs: timeout,
        ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
        signer: (nonce, expected) => fencedSigner(() => signRunnerFirstEnableProof(scope, { instanceId: options.instanceId, epoch: expected.epoch,
          request: expected.request, nonce })),
        readSigner: (nonce, expected) => fencedSigner(() => signRunnerFirstEnableReadProof(scope, { instanceId: options.instanceId, epoch: expected.epoch,
          request: expected.request, nonce })) });
      const result = await body(client, initial, controller.signal);
      fence();
      return result;
    } catch (error: unknown) {
      if (signal?.aborted) fail("cancelled");
      if (error instanceof PrivateOwnerApprovalError) throw error;
      // The SDK reports a throwing signer (our lease fence) as invalid_response: a lease that moved is never a mismatch.
      if (signerFailed || !leaseHeld()) fail("lease_unavailable");
      // A validated-but-unexpected backend answer (a check code for other terms, foreign evidence) is a mismatch, never success.
      return fail(error instanceof AgentSdkError && error.code === "invalid_response" ? "approval_mismatch" : "approval_unavailable",
        error instanceof AgentSdkError && typeof error.status === "number" ? error.status : undefined);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); controller.abort(); }
  };
  return {
    create: (agentId, identity, request, signal, timeoutMs) => fenced(agentId, identity, signal, timeoutMs, async (client, lease, abort) => {
      const challenge = await client.requestFirstEnable(request, lease.epoch, abort);
      // The exact target the client pinned and validated the answer against.
      const expected: RunnerFirstEnableExpectedTarget = { frontendOrigin: lease.frontendOrigin, agentId: lease.agentId, bindingDigest: lease.bindingDigest,
        runnerPublicKey: lease.runnerPublicKey, instanceId: lease.instanceId, epoch: lease.epoch, request };
      return { challenge, expected };
    }),
    read: (agentId, identity, request, signal, timeoutMs) => fenced(agentId, identity, signal, timeoutMs,
      (client, lease, abort) => client.readFirstEnable(request, lease.epoch, abort)),
  };
}

export interface PrivateOwnerApprovalsOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this store never creates a second lock. */
  assertAvailable(): void;
  /** The pinned owner identity. In the daemon (A2a, plan section B4) it is the sealed owner pin (`PrivateOwnerPins.identity`): a missing,
   * invalid or mismatched pin, or a locked wallet, throws, and every verify, accept and cover then fails closed (state_unavailable; arming
   * reports the pin refusal itself before asking). Undefined when not adopted. */
  readIdentity(agentId: string): PairingOwnerApprovalIdentity | undefined;
  transport?: PrivateOwnerApprovalTransport;
  now?(): number;
  monotonicNow?(): number;
  /** Test seam for the per-agent spacing wait. */
  sleep?(ms: number, signal: AbortSignal | undefined): Promise<void>;
}
/** `perTrade` and `daily` are the limits this code approves, for the CLI to print next to the code. */
export type PrivateOwnerApprovalLink = { kind: "link"; challengeId: string; checkCode: string; expiresAt: string; frontendOrigin: string; path: string }
  & PrivateOwnerApprovalCaps;
type Slot = { kind: "held" } | { kind: "open"; storage: OwnedJsonSnapshot<Snapshot> };

export class PrivateOwnerApprovals {
  readonly #options: PrivateOwnerApprovalsOptions;
  readonly #agentIds: string[];
  readonly #slots = new Map<string, Slot>();
  readonly #lastCreate = new Map<string, number>();
  readonly #lastRead = new Map<string, number>();
  #closed = false;

  constructor(options: PrivateOwnerApprovalsOptions) {
    if (!isRecord(options) || typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !isId(options.localProfileId)
      || !Array.isArray(options.agentIds) || options.agentIds.some((id) => !isId(id)) || typeof options.assertAvailable !== "function"
      || typeof options.readIdentity !== "function") fail();
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, directory: path.resolve(options.directory), agentIds: this.#agentIds };
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const slot of this.#slots.values()) if (slot.kind === "open") { try { slot.storage.close(); } catch { /* Preserve files. */ } }
  }

  /** Offline: does a stored approval, re-verified now against the runner's own facts, cover the current caps? Throws
   * (state_unavailable) when the identity or the snapshot cannot be read: corruption fails closed, never "missing". */
  covers(agentId: string, binding: PrivateOwnerApprovalBinding, current: PrivateOwnerApprovalCaps): PrivateOwnerApprovalCoverage {
    const facts = this.#facts(agentId, binding);
    if (facts.identity.pairedWallet.chain !== "solana" || !chainId(facts.identity.chainId)) return "owner_approval_unverifiable";
    const record = this.#read(agentId, false)?.records.find((item) => recordKey(item) === recordKey(this.#key(facts)));
    if (!record || verifyPrivateOwnerApproval(facts, record) !== "verified") return "owner_wallet_approval_missing";
    return privateOwnerApprovalCapsCovered(record.caps, current) ? "covered" : "owner_wallet_approval_missing";
  }
  /** The stored record for these facts (public facts only), for status and tests. */
  record(agentId: string, binding: PrivateOwnerApprovalBinding): PrivateOwnerApprovalRecord | undefined {
    const facts = this.#facts(agentId, binding);
    const found = this.#read(agentId, false)?.records.find((item) => recordKey(item) === recordKey(this.#key(facts)));
    return found ? structuredClone(found) : undefined;
  }

  /**
   * First a recovery read of the latest stored approval for this binding (a restart, or a lost local file). It is accepted only for
   * terms this runner asked for: a challenge it opened (same id, nonce, times and fields, from its durable request list) or, with no
   * such request, limits EXACTLY equal to the current ones. A recovered approval for other terms (for example "no limit" signed on a
   * page whose code was ground to match) is never installed. Then the signature must verify against the pinned wallet, and the
   * answer is approved only when it covers the current caps. Otherwise one runner-signed create for exactly the current caps; the
   * check code is recomputed from the runner's OWN request and must equal Balchemy's, and the request is fsynced before the link
   * is returned. The link carries no secret.
   */
  async request(agentId: string, binding: PrivateOwnerApprovalBinding, current: PrivateOwnerApprovalCaps, basis: RunnerCapBasis,
    signal?: AbortSignal): Promise<{ kind: "approved" } | PrivateOwnerApprovalLink> {
    const transport = this.#options.transport;
    if (!transport) fail("approval_unavailable");
    const facts = this.#facts(agentId, binding);
    if (facts.identity.pairedWallet.chain !== "solana" || !chainId(facts.identity.chainId)) fail("owner_approval_unverifiable");
    // Recovery is best effort: any failure here falls through to a new challenge.
    try {
      await this.#space(this.#lastRead, agentId, PRIVATE_OWNER_APPROVAL_READ_SPACING_MS, signal);
      let latest: Readonly<RunnerFirstEnableReadResponse>;
      try { latest = await transport.read(agentId, facts.identity, { version: 1, walletBindingId: facts.walletBindingId, challengeId: null }, signal, RECOVERY_READ_TIMEOUT_MS); }
      finally { this.#lastRead.set(agentId, this.#monotonic()); }
      if (latest.state === "approved") {
        const evidence = latest.evidence;
        const asked = this.#requestFor(agentId, evidence.approvalId, facts);
        const ours = asked !== undefined && evidence.nonce === asked.nonce && evidence.issuedAt === asked.issuedAt && evidence.expiresAt === asked.expiresAt;
        let accepted: ReturnType<typeof acceptPrivateOwnerApproval> | undefined;
        if (asked && ours) accepted = acceptPrivateOwnerApproval(facts, evidence, fieldsOf(facts, asked.caps));
        else if (asked === undefined && privateOwnerApprovalCapsEqual(evidence.actionFields.caps, current)) accepted = acceptPrivateOwnerApproval(facts, evidence);
        if (accepted?.verification === "verified") {
          this.#store(agentId, facts, accepted.record);
          if (this.covers(agentId, binding, current) === "covered") return { kind: "approved" };
        }
      }
    } catch (error: unknown) {
      if (signal?.aborted) fail("cancelled");
      if (error instanceof PrivateOwnerApprovalError && error.code === "state_unavailable") throw error;
    }
    return this.#open(agentId, transport, facts, runnerFirstEnableFields(fieldsOf(facts, privateOwnerApprovalCaps(current, basis))), current, signal);
  }

  /**
   * K2 one-visit setup: one runner-signed create for EXACTLY the owner's proposed spend ceiling (both caps in lamports, basis
   * `fixed`; never `none`), with no recovery read and no "exactly the current caps" branch: the ceiling is a maximum that later lower
   * caps are covered by (`covers()`), not the current caps. Everything after the create is `request()`'s: the check code is
   * recomputed from the runner's own request and must equal Balchemy's, and the request is fsynced before the link is returned. A
   * refusal carries Balchemy's HTTP status (409 approval_stale, 429) on the error. The caller opens at most one per proposal.
   */
  async requestCeiling(agentId: string, binding: PrivateOwnerApprovalBinding, ceiling: PrivateOwnerApprovalCeiling,
    signal?: AbortSignal): Promise<PrivateOwnerApprovalLink> {
    const transport = this.#options.transport;
    if (!transport) fail("approval_unavailable");
    const facts = this.#facts(agentId, binding);
    if (facts.identity.pairedWallet.chain !== "solana" || !chainId(facts.identity.chainId)) fail("owner_approval_unverifiable");
    const current = ceilingCaps(ceiling);
    return this.#open(agentId, transport, facts, ceilingFields(facts, current), current, signal);
  }

  /** K2: the newest challenge this runner already opened (durable request list) for exactly this ceiling under the same binding key,
   * issued at or after `notBefore` and not expired, with its LOCAL check code recomputed from the runner's own request. A restart
   * resumes that challenge instead of opening a second one for the same proposal. Read-only; undefined when there is none. */
  ceilingRequest(agentId: string, binding: PrivateOwnerApprovalBinding, ceiling: PrivateOwnerApprovalCeiling, notBefore: number): PrivateOwnerApprovalLink | undefined {
    const facts = this.#facts(agentId, binding);
    if (facts.identity.pairedWallet.chain !== "solana" || !chainId(facts.identity.chainId)) return undefined;
    const current = ceilingCaps(ceiling);
    // Canonical like the stored request (both came out of runnerFirstEnableFields), so the comparison never depends on key order.
    const caps = ceilingFields(facts, current).caps;
    const key = recordKey(this.#key(facts));
    const found = (this.#read(agentId, false)?.requests ?? []).filter((item) => recordKey(item) === key && sameCaps(item.caps, caps)
      && Date.parse(item.issuedAt) >= notBefore && Date.parse(item.expiresAt) > this.#now()).at(-1);
    if (!found) return undefined;
    const checkCode = runnerFirstEnableLocalCheckCode({ agentId: facts.identity.agentId, bindingDigest: facts.identity.bindingDigest,
      runnerPublicKey: facts.identity.runnerPublicKey, nonce: found.nonce, issuedAt: found.issuedAt, expiresAt: found.expiresAt, fields: fieldsOf(facts, caps) });
    return { kind: "link", challengeId: found.challengeId, checkCode, expiresAt: found.expiresAt, frontendOrigin: facts.identity.frontendOrigin,
      path: `/hub/local-agents/${facts.identity.agentId}/approve/${found.challengeId}`, ...current };
  }

  /** One spaced runner-signed create for `fields`; the code is the runner's own and the request is durable before the link returns. */
  async #open(agentId: string, transport: PrivateOwnerApprovalTransport, facts: PrivateOwnerApprovalFacts, fields: Readonly<RunnerFirstEnableFields>,
    current: PrivateOwnerApprovalCaps, signal: AbortSignal | undefined): Promise<PrivateOwnerApprovalLink> {
    const request: RunnerFirstEnableRequest = { version: 1, ...structuredClone(fields) as RunnerFirstEnableFields };
    await this.#space(this.#lastCreate, agentId, PRIVATE_OWNER_APPROVAL_CREATE_SPACING_MS, signal);
    let created: { challenge: Readonly<RunnerFirstEnableChallenge>; expected: RunnerFirstEnableExpectedTarget };
    try { created = await transport.create(agentId, facts.identity, request, signal, CREATE_TIMEOUT_MS); }
    catch (error: unknown) {
      if (signal?.aborted) fail("cancelled");
      throw error instanceof PrivateOwnerApprovalError ? error : new PrivateOwnerApprovalError("approval_unavailable");
    } finally { this.#lastCreate.set(agentId, this.#monotonic()); }
    const { challenge, expected } = created;
    // The expected target must be this runner's own identity and request; the code is computed from it, never taken from Balchemy.
    if (leaseIdentity(expected) !== leaseIdentity(facts.identity) || JSON.stringify(runnerFirstEnableFields({ localProfileId: expected.request.localProfileId,
      tradingWalletAddress: expected.request.tradingWalletAddress, walletBindingId: expected.request.walletBindingId, caps: expected.request.caps }))
      !== JSON.stringify(fields)) fail("approval_mismatch");
    let local: string;
    try { local = runnerFirstEnableChallengeCheckCode(challenge, expected); } catch { return fail("approval_mismatch"); }
    if (local !== challenge.checkCode || !UUID.test(challenge.challengeId) || !iso(challenge.expiresAt)) fail("approval_mismatch");
    if (!HEX.test(challenge.nonce) || !iso(challenge.issuedAt) || Date.parse(challenge.expiresAt) - Date.parse(challenge.issuedAt) !== 10 * 60_000) fail("approval_mismatch");
    // Durable before the owner sees the link: a poll (even after a restart) is bound to exactly this challenge and these terms.
    this.#mutate(agentId, (snapshot) => {
      const entry: PrivateOwnerApprovalRequestRecord = { ...this.#key(facts), challengeId: challenge.challengeId, nonce: challenge.nonce,
        issuedAt: challenge.issuedAt, expiresAt: challenge.expiresAt, caps: structuredClone(fields.caps) as RunnerFirstEnableCaps };
      const requests = [...snapshot.requests.filter((item) => item.challengeId !== entry.challengeId), entry]
        .sort((a, b) => Date.parse(a.issuedAt) - Date.parse(b.issuedAt)).slice(-MAX_REQUESTS);
      return { ...snapshot, requests };
    });
    return { kind: "link", challengeId: challenge.challengeId, checkCode: local, expiresAt: challenge.expiresAt, frontendOrigin: facts.identity.frontendOrigin,
      path: `/hub/local-agents/${facts.identity.agentId}/approve/${challenge.challengeId}`, perTrade: current.perTrade, daily: current.daily };
  }

  /** One runner-signed read of a challenge this runner opened (from its durable request list). `approved` only after the evidence is
   * for exactly that challenge (id, nonce, times) and the runner's own requested fields, the signature verifies over the message
   * re-derived from its own facts and requested caps, and the record was fsynced (or that same approval was already stored). A newer
   * different approval already stored refuses `approval_superseded`. */
  async poll(agentId: string, challengeId: string, signal?: AbortSignal): Promise<"pending" | "approved" | "expired"> {
    const transport = this.#options.transport;
    if (!transport) fail("approval_unavailable");
    const asked = this.#read(agentId, false)?.requests.find((item) => item.challengeId === challengeId);
    // Unknown here (never opened by this runner, or rotated out): the owner reruns arm, which recovers or opens a new link.
    if (!asked) return "expired";
    const facts = this.#facts(agentId, { walletBindingId: asked.walletBindingId, tradingWalletAddress: asked.tradingWalletAddress });
    // A different pairing since the request: that challenge can no longer approve this identity.
    if (recordKey(this.#key(facts)) !== recordKey(asked)) return "expired";
    await this.#space(this.#lastRead, agentId, PRIVATE_OWNER_APPROVAL_READ_SPACING_MS, signal);
    let answer: Readonly<RunnerFirstEnableReadResponse>;
    try { answer = await transport.read(agentId, facts.identity, { version: 1, walletBindingId: facts.walletBindingId, challengeId }, signal, POLL_TIMEOUT_MS); }
    catch (error: unknown) {
      if (signal?.aborted) fail("cancelled");
      throw error instanceof PrivateOwnerApprovalError ? error : new PrivateOwnerApprovalError("approval_unavailable");
    } finally { this.#lastRead.set(agentId, this.#monotonic()); }
    if (answer.state === "pending") return this.#now() > Date.parse(asked.expiresAt) + CLOCK_SKEW_MS ? "expired" : "pending";
    if (answer.state === "none") return "expired";
    const evidence = answer.evidence;
    if (evidence.approvalId !== challengeId || evidence.nonce !== asked.nonce || evidence.issuedAt !== asked.issuedAt
      || evidence.expiresAt !== asked.expiresAt) fail("approval_mismatch");
    const accepted = acceptPrivateOwnerApproval(facts, evidence, fieldsOf(facts, asked.caps));
    if (accepted.verification === "unverifiable") fail("owner_approval_unverifiable");
    if (accepted.verification !== "verified") fail("approval_mismatch");
    if (this.#store(agentId, facts, accepted.record) === "kept_newer") fail("approval_superseded");
    return "approved";
  }

  /** A request this runner opened for `challengeId` under the same binding key, if any. */
  #requestFor(agentId: string, challengeId: string, facts: PrivateOwnerApprovalFacts): PrivateOwnerApprovalRequestRecord | undefined {
    const found = this.#read(agentId, false)?.requests.find((item) => item.challengeId === challengeId);
    return found && recordKey(found) === recordKey(this.#key(facts)) ? found : undefined;
  }
  #facts(agentId: string, binding: PrivateOwnerApprovalBinding): PrivateOwnerApprovalFacts {
    if (this.#closed) fail();
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail();
    let identity: PairingOwnerApprovalIdentity | undefined;
    try { identity = this.#options.readIdentity(agentId); } catch { return fail(); }
    if (!identity || typeof binding.walletBindingId !== "string" || !UUID.test(binding.walletBindingId) || !isSolanaAddress(binding.tradingWalletAddress)) fail();
    return { localProfileId: this.#options.localProfileId, identity: structuredClone(identity), walletBindingId: binding.walletBindingId,
      tradingWalletAddress: binding.tradingWalletAddress };
  }
  #key(facts: PrivateOwnerApprovalFacts): Pick<PrivateOwnerApprovalRecord, "serverAgentId" | "bindingDigest" | "runnerPublicKey" | "walletBindingId" | "tradingWalletAddress"> {
    return { serverAgentId: facts.identity.agentId, bindingDigest: facts.identity.bindingDigest, runnerPublicKey: facts.identity.runnerPublicKey,
      walletBindingId: facts.walletBindingId, tradingWalletAddress: facts.tradingWalletAddress };
  }
  /** Keeps only the newest verified approval per key: a stored record that still verifies and is not older is never replaced.
   * `stored`: written and fsynced; `kept_same`: this very approval was already stored; `kept_newer`: a newer different one was. */
  #store(agentId: string, facts: PrivateOwnerApprovalFacts, record: PrivateOwnerApprovalRecord): "stored" | "kept_same" | "kept_newer" {
    if (verifyPrivateOwnerApproval(facts, record) !== "verified") fail("approval_mismatch");
    const key = recordKey(record);
    let result: "stored" | "kept_same" | "kept_newer" = "stored";
    this.#mutate(agentId, (snapshot) => {
      const existing = snapshot.records.find((item) => recordKey(item) === key);
      if (existing && verifyPrivateOwnerApproval(facts, existing) === "verified" && Date.parse(existing.approvedAt) >= Date.parse(record.approvedAt)) {
        result = existing.approvalId === record.approvalId && existing.signature === record.signature ? "kept_same" : "kept_newer";
        return undefined;
      }
      const records = [...snapshot.records.filter((item) => recordKey(item) !== key), structuredClone(record)]
        .sort((a, b) => Date.parse(a.approvedAt) - Date.parse(b.approvedAt)).slice(-MAX_RECORDS);
      return { ...snapshot, records };
    });
    return result;
  }
  /** One synchronous read-change-commit section; `undefined` writes nothing. Any read or write failure holds the agent's file. */
  #mutate(agentId: string, change: (snapshot: Snapshot) => Snapshot | undefined): void {
    const slot = this.#slot(agentId, true);
    if (!slot || slot.kind !== "open") return fail();
    let snapshot: Snapshot;
    try { snapshot = slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail(); }
    const next = change(snapshot);
    if (!next) return;
    try { slot.storage.commit(parseSnapshot(structuredClone(next), { localProfileId: this.#options.localProfileId, agentId })); }
    catch { this.#slots.set(agentId, { kind: "held" }); return fail(); }
  }
  #read(agentId: string, create: boolean): Snapshot | undefined {
    const slot = this.#slot(agentId, create);
    if (!slot) return undefined;
    if (slot.kind === "held") return fail();
    try { return slot.storage.read(); } catch { this.#slots.set(agentId, { kind: "held" }); return fail(); }
  }
  #slot(agentId: string, create: boolean): Slot | undefined {
    if (this.#closed) fail();
    try { this.#options.assertAvailable(); } catch { return fail(); }
    const current = this.#slots.get(agentId);
    if (current) return current;
    const files = privateOwnerApprovalFiles(agentId);
    const exists = (name: string): boolean => {
      try { fs.lstatSync(path.join(this.#options.directory, name)); return true; }
      catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return false; throw error; }
    };
    try { if (!create && !exists(files.markerFile) && !exists(files.snapshotFile)) return undefined; }
    catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
    try {
      const scope = { localProfileId: this.#options.localProfileId, agentId };
      const storage = new OwnedJsonSnapshot<Snapshot>({ directory: this.#options.directory, ...files,
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId, kind: "owner_approvals" }, maximumBytes: MAX_SNAPSHOT_BYTES,
        initial: { schemaVersion: 1, ...scope, records: [], requests: [] }, assertAvailable: this.#options.assertAvailable, decode: (value) => parseSnapshot(value, scope) });
      const slot: Slot = { kind: "open", storage };
      this.#slots.set(agentId, slot);
      return slot;
    } catch { const held: Slot = { kind: "held" }; this.#slots.set(agentId, held); return held; }
  }
  #now(): number { return (this.#options.now ?? Date.now)(); }
  #monotonic(): number { return (this.#options.monotonicNow ?? (() => performance.now()))(); }
  /** Waits until this agent's previous create (or read) ended at least `spacingMs` ago. A cancelled wait sends nothing. */
  async #space(last: Map<string, number>, agentId: string, spacingMs: number, signal: AbortSignal | undefined): Promise<void> {
    const wait = (last.get(agentId) ?? -Infinity) + spacingMs - this.#monotonic();
    if (wait > 0) {
      try { await (this.#options.sleep ?? ((ms: number, s: AbortSignal | undefined) => delay(ms, undefined, s ? { signal: s } : undefined)))(Math.ceil(wait), signal); }
      catch { return fail("cancelled"); }
    }
    if (signal?.aborted) fail("cancelled");
  }
}
