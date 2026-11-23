import { base64, exactWith, HEX, invalidFor, matches, sha256, solanaAddress, timestampWith, U64_MAX, UUID, type ExactFn } from "./runner-proof-transport";

/**
 * Moment 3 (`first_enable`) owner-approval message, rebuilt by the runner from its OWN facts. It mirrors the backend renderer
 * byte for byte (`approvalDigest`, `approvalStatement`, `renderOwnerWalletMessage` in balchemy-backend
 * `owner-wallet-approval.message.ts` and `owner-wallet-signature.ts`); both sides pin the same golden strings. Solana-paired
 * owners only: a Base-paired owner cannot be verified by the runner yet (`owner_approval_unverifiable`, the runner's call).
 * Domain and URI come from the pinned frontend origin plus `/hub/approvals`. The chain id is a validated parameter: the one the
 * owner signed at PAIRING, taken by the runner from its locally pinned pairing record (one of RUNNER_OWNER_APPROVAL_CHAIN_IDS,
 * the set the pairing client accepts). It is never a constant here, so a deployment on another Solana cluster re-derives the
 * exact bytes its backend rendered; any other value refuses (fail closed).
 */
export const RUNNER_OWNER_APPROVAL_PURPOSE = "balchemy.owner-approval.v1" as const;
export const RUNNER_OWNER_APPROVAL_TTL_MS = 10 * 60 * 1000;
export const RUNNER_OWNER_APPROVAL_URI_PATH = "/hub/approvals";
/** The Solana chain ids a paired owner can carry (the pairing client's accepted set). */
export const RUNNER_OWNER_APPROVAL_CHAIN_IDS = Object.freeze(["solana:mainnet", "solana:mainnet-beta", "solana:devnet", "solana:testnet"] as const);
export type RunnerOwnerApprovalChainId = typeof RUNNER_OWNER_APPROVAL_CHAIN_IDS[number];

export type RunnerSignableCap = { kind: "none" } | { kind: "lamports"; lamports: string };
/** Display only: the signed text states it, coverage compares lamports only. */
export type RunnerCapBasis = "fixed" | { percentBps: number; balanceLamports: string; observedAt: string };
export interface RunnerFirstEnableCaps { perTrade: RunnerSignableCap; daily: RunnerSignableCap; basis: RunnerCapBasis }
/** The signed action fields, in the backend's key order. */
export interface RunnerFirstEnableFields {
  localProfileId: string; tradingWalletAddress: string; walletBindingId: string; caps: RunnerFirstEnableCaps;
}
export interface RunnerFirstEnableMessageInput {
  frontendOrigin: string; agentId: string; bindingDigest: string; runnerPublicKey: string;
  /** The paired owner wallet the runner pinned at pairing (never a backend-supplied value). */
  pairedWallet: { chain: "solana"; address: string };
  /** The chain id from the locally pinned pairing record (never a backend-supplied value). */
  chainId: RunnerOwnerApprovalChainId;
  nonce: string; issuedAt: string; expiresAt: string; fields: RunnerFirstEnableFields;
}

const invalid: () => never = invalidFor("owner approval");
const exact: ExactFn = exactWith(invalid);
const timestamp = timestampWith(invalid);
const PROFILE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const STATEMENT_CHARACTERS = /^[A-Za-z0-9 .,:;()/+=_-]+$/;
const OBSERVED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function u64(value: unknown, minimum: bigint): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value)) invalid();
  const parsed = BigInt(value as string);
  if (parsed < minimum || parsed > U64_MAX) invalid();
  return value as string;
}
function cap(value: unknown): RunnerSignableCap {
  exact(value, ["kind"], ["lamports"]);
  if (value.kind === "none" && !Object.hasOwn(value, "lamports")) return { kind: "none" };
  // `unset` (never answered) and anything else are never signable.
  if (value.kind !== "lamports" || !Object.hasOwn(value, "lamports")) invalid();
  return { kind: "lamports", lamports: u64(value.lamports, 1n) };
}
function basis(value: unknown): RunnerCapBasis {
  if (value === "fixed") return "fixed";
  exact(value, ["percentBps", "balanceLamports", "observedAt"]);
  const percentBps = value.percentBps;
  if (typeof percentBps !== "number" || !Number.isSafeInteger(percentBps) || percentBps < 1 || percentBps > 10_000
    || !matches(value.observedAt, OBSERVED_AT)) invalid();
  const observedAt = value.observedAt as string;
  if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) invalid();
  return { percentBps: percentBps as number, balanceLamports: u64(value.balanceLamports, 0n), observedAt };
}

/** Closed, canonical first_enable fields (the backend's `canonicalActionFields('first_enable', ...)` rules). */
export function runnerFirstEnableFields(value: unknown): Readonly<RunnerFirstEnableFields> {
  exact(value, ["localProfileId", "tradingWalletAddress", "walletBindingId", "caps"]);
  const caps: unknown = value.caps;
  exact(caps, ["perTrade", "daily", "basis"]);
  const perTrade = cap(caps.perTrade); const daily = cap(caps.daily);
  if (perTrade.kind === "lamports" && daily.kind === "lamports" && BigInt(perTrade.lamports) > BigInt(daily.lamports)) invalid();
  const signedBasis = basis(caps.basis);
  if (!matches(value.localProfileId, PROFILE_ID) || !solanaAddress(value.tradingWalletAddress) || !matches(value.walletBindingId, UUID)) invalid();
  return Object.freeze({ localProfileId: value.localProfileId as string, tradingWalletAddress: value.tradingWalletAddress as string,
    walletBindingId: value.walletBindingId as string, caps: Object.freeze({ perTrade: Object.freeze(perTrade), daily: Object.freeze(daily),
      basis: signedBasis === "fixed" ? "fixed" : Object.freeze(signedBasis) }) });
}

interface PinnedInput extends Omit<RunnerFirstEnableMessageInput, "fields"> { fields: Readonly<RunnerFirstEnableFields>; domain: string; uri: string }
function pinned(value: RunnerFirstEnableMessageInput): PinnedInput {
  exact(value, ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "pairedWallet", "chainId", "nonce", "issuedAt", "expiresAt", "fields"]);
  if (!(RUNNER_OWNER_APPROVAL_CHAIN_IDS as readonly unknown[]).includes(value.chainId)) invalid();
  const wallet: unknown = value.pairedWallet;
  exact(wallet, ["chain", "address"]);
  if (wallet.chain !== "solana" || !solanaAddress(wallet.address) || !matches(value.agentId, UUID)
    || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32) || !matches(value.nonce, HEX)
    || typeof value.frontendOrigin !== "string") invalid();
  let url: URL;
  try { url = new URL(value.frontendOrigin); } catch { return invalid(); }
  if (url.origin !== value.frontendOrigin || url.username || url.password
    || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) invalid();
  const issued = timestamp(value.issuedAt); const expires = timestamp(value.expiresAt);
  if (expires - issued !== RUNNER_OWNER_APPROVAL_TTL_MS) invalid();
  const fields = runnerFirstEnableFields(value.fields);
  // The trading wallet is never the paired owner wallet (the backend refuses that at challenge creation).
  if (fields.tradingWalletAddress === value.pairedWallet.address) invalid();
  return { frontendOrigin: value.frontendOrigin, agentId: value.agentId, bindingDigest: value.bindingDigest, runnerPublicKey: value.runnerPublicKey,
    pairedWallet: { chain: "solana", address: value.pairedWallet.address }, chainId: value.chainId, nonce: value.nonce, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    fields, domain: url.host.toLowerCase(), uri: `${url.origin}${RUNNER_OWNER_APPROVAL_URI_PATH}` };
}

/** Everything the approval digest (and so the check code) binds: no origin, no paired wallet and no chain id. */
export interface RunnerFirstEnableDigestInput {
  agentId: string; bindingDigest: string; runnerPublicKey: string; nonce: string; issuedAt: string; expiresAt: string; fields: RunnerFirstEnableFields;
}
type DigestPinned = Omit<PinnedInput, "frontendOrigin" | "pairedWallet" | "chainId" | "domain" | "uri">;
function pinnedDigest(value: RunnerFirstEnableDigestInput): DigestPinned {
  exact(value, ["agentId", "bindingDigest", "runnerPublicKey", "nonce", "issuedAt", "expiresAt", "fields"]);
  if (!matches(value.agentId, UUID) || !matches(value.bindingDigest, HEX) || !base64(value.runnerPublicKey, 32) || !matches(value.nonce, HEX)) invalid();
  const issued = timestamp(value.issuedAt); const expires = timestamp(value.expiresAt);
  if (expires - issued !== RUNNER_OWNER_APPROVAL_TTL_MS) invalid();
  return { agentId: value.agentId, bindingDigest: value.bindingDigest, runnerPublicKey: value.runnerPublicKey, nonce: value.nonce,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt, fields: runnerFirstEnableFields(value.fields) };
}
/**
 * The check code computed LOCALLY from the runner's own identity and request plus the challenge's nonce and times. The CLI prints
 * this local code, never the backend's; a backend code that differs means the challenge is not the one the runner asked for.
 */
export function runnerFirstEnableLocalCheckCode(input: RunnerFirstEnableDigestInput): string {
  return digestOf(pinnedDigest(input)).slice(0, 6).toUpperCase();
}

const capTuple = (value: RunnerSignableCap): string[] => (value.kind === "none" ? ["none"] : ["lamports", value.lamports]);
function digestOf(p: DigestPinned): string {
  const f = p.fields; const b = f.caps.basis;
  return sha256([RUNNER_OWNER_APPROVAL_PURPOSE, "first_enable", p.agentId, p.bindingDigest, p.runnerPublicKey, p.nonce, p.issuedAt, p.expiresAt,
    f.localProfileId, f.tradingWalletAddress, f.walletBindingId, capTuple(f.caps.perTrade), capTuple(f.caps.daily),
    b === "fixed" ? "fixed" : ["percent", b.percentBps, b.balanceLamports, b.observedAt]]);
}

/** Exact decimal SOL for integer lamports, without floating point. */
function lamportsToSol(lamports: string): string {
  const value = BigInt(lamports);
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
const shortAddress = (address: string): string => `${address.slice(0, 4)}...${address.slice(-4)}`;
const capText = (value: RunnerSignableCap): string => (value.kind === "none" ? "no limit" : `${lamportsToSol(value.lamports)} SOL`);

function statementOf(p: PinnedInput): string {
  const f = p.fields;
  const caps = f.caps.perTrade.kind === "none" && f.caps.daily.kind === "none" ? "no spend limit"
    : `per trade ${capText(f.caps.perTrade)}, per day ${capText(f.caps.daily)}`;
  const b = f.caps.basis;
  const fixedFrom = b === "fixed" ? "" : ` (fixed from ${lamportsToSol(String(b.percentBps * 10_000_000))} percent of ${lamportsToSol(b.balanceLamports)} SOL)`;
  const statement = "Balchemy approval, not a sign-in. No funds move. " +
    `Allow automatic trading for agent ${p.agentId.slice(0, 8)} on runner key ${p.runnerPublicKey.slice(0, 8)} ` +
    `with trading wallet ${shortAddress(f.tradingWalletAddress)}: ${caps}${fixedFrom}. Stop-loss works only while this computer is on and unlocked.`;
  if (!STATEMENT_CHARACTERS.test(statement)) invalid();
  return statement;
}

/** `sha256(JSON.stringify([purpose, "first_enable", agentId, bindingDigest, runnerPublicKey, nonce, issuedAt, expiresAt, ...fields]))`. */
export function runnerFirstEnableApprovalDigest(input: RunnerFirstEnableMessageInput): string { return digestOf(pinned(input)); }
/** Six characters the CLI prints and Hub shows for the same challenge. */
export function runnerFirstEnableCheckCode(input: RunnerFirstEnableMessageInput): string { return digestOf(pinned(input)).slice(0, 6).toUpperCase(); }
export function runnerFirstEnableApprovalStatement(input: RunnerFirstEnableMessageInput): string { return statementOf(pinned(input)); }

/** The exact SIWS bytes the owner signs (UTF-8), re-derived from the runner's own facts plus the signed caps. */
export function runnerFirstEnableApprovalMessage(input: RunnerFirstEnableMessageInput): string {
  const p = pinned(input);
  return [
    `${p.domain} wants you to sign in with your Solana account:`,
    p.pairedWallet.address, "", statementOf(p), "",
    `URI: ${p.uri}`, "Version: 1", `Chain ID: ${p.chainId}`,
    `Nonce: ${p.nonce}`, `Issued At: ${p.issuedAt}`, `Expiration Time: ${p.expiresAt}`,
    "Resources:", `- urn:balchemy:owner-approval:v1:first_enable:${digestOf(p)}`,
  ].join("\n");
}
