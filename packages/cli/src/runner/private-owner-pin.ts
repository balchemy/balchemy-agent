/** A2a sealed owner pin (plan section B): the owner-approval identity this runner trusts, sealed with a purpose-fixed tag of the
 * trading wallet's unlocked key (private-trading-keystore.ts authorityTag, purpose `owner_pin`).
 *
 * The plaintext pairing records (pairing-identity.ts) are same-user files: a process that rewrites them could name another owner
 * wallet, and arming would then trust an approval signed by that wallet (a0-socket-pairing.spec.ts, substituteOwner). The pin seals
 * the owner wallet, chain id, Balchemy agent, binding digest, runner key and frontend origin of the adopted pairing, plus the trading
 * wallet address, once the owner compared the WHOLE owner address with the wallet signed in to Hub and typed its last six characters
 * (six characters alone are attention, not authentication). From then on `identity()` is the authority read: it answers the pinned
 * identity only while the pin verifies and the plaintext record still equals it.
 *
 * Fields are public; "sealed" means an HMAC tag. The pinned address stays readable while locked, marked unverified. Migration is
 * trust-on-first-use: a pairing record swapped before the first seal shows the attacker's address on the card (documented residual).
 * Nothing here signs, arms or reads a secret; the trading key never leaves the keystore. One snapshot per agent,
 * `owner-pin-<sha256(agentId)>.json` + `.initialized` (never `trading-wallet-`: that prefix is the keystore's), created only by a seal. */
import { createHash } from "node:crypto";
import { isId, isRecord, isTimestamp } from "./protocol.js";
import { isSolanaAddress } from "./solana-base58.js";
import type { PairingOwnerApprovalIdentity } from "./pairing-identity.js";
import { PrivateAgentRecords, privateAuthorityKeystoreCode, type PrivateAuthorityKeystore } from "./private-authority-seal.js";
import { isPrivateOwnerAddress, isPrivateOwnerChainId, isPrivateOwnerOrigin, privateOwnerSuffixMatches,
  type PrivateOwnerPairingView, type PrivateOwnerPinView, type PrivateOwnerWallet } from "./private-owner-pin-protocol.js";
import type { TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import { runnerKeyFingerprint } from "./runner-key-fingerprint.js";

export const PRIVATE_OWNER_PIN_SUITE = "hkdf-sha256+hmac-sha256/v1" as const;
const RECORD_TUPLE = "balchemy.owner-pin.record.v1";
const MAX_RECORD_BYTES = 8 * 1024;
const HEX = /^[0-9a-f]{64}$/;
const RUNNER_KEY = /^[A-Za-z0-9+/]{43}=$/;

export function privateOwnerPinFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `owner-pin-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
interface PinRecord {
  schemaVersion: 1; suite: typeof PRIVATE_OWNER_PIN_SUITE; localProfileId: string; localAgentId: string; serverAgentId: string;
  frontendOrigin: string; tradingWalletAddress: string; ownerWallet: PrivateOwnerWallet; chainId: string; bindingDigest: string;
  runnerPublicKey: string; pinnedAt: number; mac: string;
}
export type PrivateOwnerPinErrorCode = "owner_pin_missing" | "owner_pin_invalid" | "owner_pin_mismatch" | "wallet_locked" | "wallet_missing"
  | "not_paired" | "shown_mismatch" | "suffix_mismatch" | "invalid_request" | "unknown_agent" | "closing" | "state_unavailable" | "write_outcome_unknown";
export class PrivateOwnerPinError extends Error {
  constructor(readonly code: PrivateOwnerPinErrorCode) { super(`Owner pin ${code}`); this.name = "PrivateOwnerPinError"; }
}
function fail(code: PrivateOwnerPinErrorCode): never { throw new PrivateOwnerPinError(code); }
/** Store-level codes (closing, unknown_agent, state_unavailable, write_outcome_unknown) pass through unchanged. */
function rethrow(error: unknown): never {
  const code = isRecord(error) ? error.code : undefined;
  if (code === "closing" || code === "unknown_agent" || code === "state_unavailable" || code === "write_outcome_unknown") fail(code);
  return fail("state_unavailable");
}
const origin = isPrivateOwnerOrigin;
function wallet(value: unknown): PrivateOwnerWallet | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2 || (value.chain !== "solana" && value.chain !== "base") || !isPrivateOwnerAddress(value.address)
    || (value.chain === "solana") !== isSolanaAddress(value.address)) return undefined;
  return { chain: value.chain as "solana" | "base", address: value.address as string };
}
/** The pairing identity a pin may hold; anything else is never sealed. */
function sealable(identity: PairingOwnerApprovalIdentity): boolean {
  return isRecord(identity) && origin(identity.frontendOrigin) && isId(identity.agentId) && typeof identity.bindingDigest === "string" && HEX.test(identity.bindingDigest)
    && typeof identity.runnerPublicKey === "string" && RUNNER_KEY.test(identity.runnerPublicKey) && wallet(identity.pairedWallet) !== undefined
    && isPrivateOwnerChainId(identity.chainId);
}
/** What the card shows of a pairing identity: every field `sameIdentity` compares (the runner key as its fingerprint). */
function identityView(identity: PairingOwnerApprovalIdentity): PrivateOwnerPairingView {
  return { owner: { chain: identity.pairedWallet.chain, address: identity.pairedWallet.address }, bindingDigest: identity.bindingDigest,
    frontendOrigin: identity.frontendOrigin, serverAgentId: identity.agentId, chainId: identity.chainId,
    runnerFingerprint: runnerKeyFingerprint(identity.runnerPublicKey) };
}
function recordView(record: PinRecord): PrivateOwnerPairingView {
  return { owner: { ...record.ownerWallet }, bindingDigest: record.bindingDigest, frontendOrigin: record.frontendOrigin,
    serverAgentId: record.serverAgentId, chainId: record.chainId, runnerFingerprint: runnerKeyFingerprint(record.runnerPublicKey) };
}
function sameIdentity(record: PinRecord, identity: PairingOwnerApprovalIdentity): boolean {
  return record.frontendOrigin === identity.frontendOrigin && record.serverAgentId === identity.agentId && record.bindingDigest === identity.bindingDigest
    && record.runnerPublicKey === identity.runnerPublicKey && record.ownerWallet.chain === identity.pairedWallet.chain
    && record.ownerWallet.address === identity.pairedWallet.address && record.chainId === identity.chainId;
}
/** The keystore tuple: it must start with the trading address (the keystore checks it); the keystore adds the purpose, profile, local
 * agent and address. */
function pinFields(record: Omit<PinRecord, "mac">): string[] {
  return [record.tradingWalletAddress, RECORD_TUPLE, record.suite, record.serverAgentId, record.frontendOrigin, record.ownerWallet.chain,
    record.ownerWallet.address, record.chainId, record.bindingDigest, record.runnerPublicKey, String(record.pinnedAt)];
}

/** What the seal card showed (every pinned pairing field, the runner key as its fingerprint) plus the typed last six characters. */
export interface PrivateOwnerPinShown {
  ownerAddress: string; bindingDigest: string; frontendOrigin: string; serverAgentId: string; chainId: string; runnerFingerprint: string; suffix: string;
}
export interface PrivateOwnerPinsOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this store never creates a second lock. */
  assertAvailable(): void;
  keystore: PrivateAuthorityKeystore;
  /** The plaintext pairing reader (readPairingOwnerApprovalIdentity); undefined until the pairing is adopted. */
  readIdentity(agentId: string): PairingOwnerApprovalIdentity | undefined;
  now?(): number;
}
export class PrivateOwnerPins {
  readonly #options: PrivateOwnerPinsOptions;
  readonly #records: PrivateAgentRecords<PinRecord>;
  constructor(options: PrivateOwnerPinsOptions) {
    if (!isRecord(options) || typeof options.readIdentity !== "function" || typeof options.keystore !== "object" || options.keystore === null
      || typeof options.keystore.authorityTag !== "function" || typeof options.keystore.verifyAuthorityTag !== "function"
      || typeof options.keystore.status !== "function" || (options.now !== undefined && typeof options.now !== "function")) fail("invalid_request");
    this.#options = options;
    this.#records = new PrivateAgentRecords<PinRecord>({ directory: options.directory, localProfileId: options.localProfileId,
      agentIds: [...options.agentIds], kind: "owner_pin", maximumBytes: MAX_RECORD_BYTES, files: privateOwnerPinFiles,
      assertAvailable: options.assertAvailable, decode: (value, agentId) => this.#decode(value, agentId) });
  }
  addAgent(agentId: string): void { this.#records.addAgent(agentId); }
  /** True when a pin record (or a partial one) exists on disk: the no-wallet bootstrap exception must not apply then. */
  exists(agentId: string): boolean {
    try { this.#records.available(agentId); return this.#records.present(agentId); } catch (error: unknown) { return rethrow(error); }
  }

  /** What the seal card shows. Never writes and never throws for a pin problem (that is the state). */
  status(agentId: string): PrivateOwnerPinView {
    let present: boolean;
    try { this.#records.available(agentId); present = this.#records.present(agentId); } catch (error: unknown) { return rethrow(error); }
    let identity: PairingOwnerApprovalIdentity | undefined;
    try { identity = this.#options.readIdentity(agentId); } catch { return { state: "held", pairing: null, pinned: null }; }
    if (identity && !sealable(identity)) return { state: "held", pairing: null, pinned: null };
    const pairing = identity ? identityView(identity) : null;
    let record: PinRecord | undefined;
    try { record = present ? this.#records.read(agentId) : undefined; } catch { return { state: "invalid", pairing, pinned: null }; }
    if (!record) return { state: pairing ? "unpinned" : "unpaired", pairing, pinned: null };
    const pinned = { ...recordView(record), pinnedAt: record.pinnedAt };
    const status = this.#wallet(agentId);
    if (status === undefined || status.state === "held") return { state: "held", pairing, pinned };
    if (status.state === "absent" || status.address !== record.tradingWalletAddress) return { state: "mismatch", pairing, pinned };
    if (status.state === "locked") return { state: "pinned_locked", pairing, pinned };
    let valid: boolean;
    try { valid = this.#options.keystore.verifyAuthorityTag(agentId, "owner_pin", pinFields(record), record.mac); }
    catch (error: unknown) { return { state: privateAuthorityKeystoreCode(error) === "wallet_locked" ? "pinned_locked" : "held", pairing, pinned }; }
    if (!valid) return { state: "invalid", pairing, pinned: null };
    return { state: identity && sameIdentity(record, identity) ? "pinned" : "mismatch", pairing, pinned };
  }

  /** The authority read (owner approvals, the ceiling worker, arming): the identity built from the verified pin. Refuses, in this order:
   * `owner_pin_missing` (no pin file), `wallet_locked`, `owner_pin_mismatch` (another trading wallet), `owner_pin_invalid` (unreadable or
   * not verifying), `owner_pin_mismatch` (the plaintext pairing record differs from the pin, or is gone). */
  identity(agentId: string): PairingOwnerApprovalIdentity {
    let present: boolean;
    try { this.#records.available(agentId); present = this.#records.present(agentId); } catch (error: unknown) { return rethrow(error); }
    if (!present) fail("owner_pin_missing");
    const status = this.#wallet(agentId);
    if (status === undefined || status.state === "held") fail("state_unavailable");
    if (status.state === "locked") fail("wallet_locked");
    let record: PinRecord | undefined;
    try { record = this.#records.read(agentId); } catch (error: unknown) {
      const code = isRecord(error) ? error.code : undefined;
      if (code === "closing" || code === "unknown_agent") return rethrow(error);
      return fail("owner_pin_invalid");
    }
    if (!record) fail("owner_pin_missing");
    if (status.state === "absent" || status.address !== record.tradingWalletAddress) fail("owner_pin_mismatch");
    let valid: boolean;
    try { valid = this.#options.keystore.verifyAuthorityTag(agentId, "owner_pin", pinFields(record), record.mac); }
    catch (error: unknown) { return fail(privateAuthorityKeystoreCode(error) === "wallet_locked" ? "wallet_locked" : "state_unavailable"); }
    if (!valid) fail("owner_pin_invalid");
    let plain: PairingOwnerApprovalIdentity | undefined;
    try { plain = this.#options.readIdentity(agentId); } catch { return fail("state_unavailable"); }
    if (!plain || !sameIdentity(record, plain)) fail("owner_pin_mismatch");
    return { frontendOrigin: record.frontendOrigin, agentId: record.serverAgentId, bindingDigest: record.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, pairedWallet: { ...record.ownerWallet }, chainId: record.chainId };
  }

  /** The seal step (the daemon has verified the passphrase proof first): `shown` is what the card showed and the owner typed (every
   * pairing field the pin seals). The plaintext record is re-read and any difference refuses `shown_mismatch`; the suffix must be the
   * address's last six characters. Needs an unlocked wallet. Creates or replaces the pin; replacing a valid pin is this same explicit
   * step, never a side effect. */
  seal(agentId: string, shown: PrivateOwnerPinShown): PrivateOwnerPinView {
    try { this.#records.available(agentId); } catch (error: unknown) { return rethrow(error); }
    if (!isRecord(shown) || typeof shown.suffix !== "string"
      || !(["ownerAddress", "bindingDigest", "frontendOrigin", "serverAgentId", "chainId", "runnerFingerprint"] as const).every((key) => typeof shown[key] === "string")) {
      fail("invalid_request");
    }
    let identity: PairingOwnerApprovalIdentity | undefined;
    try { identity = this.#options.readIdentity(agentId); } catch { return fail("state_unavailable"); }
    if (!identity) fail("not_paired");
    if (!sealable(identity)) fail("state_unavailable");
    const current = identityView(identity);
    // Every pinned field, not only the address: a Hub origin, agent, network or runner key changed after the card showed it refuses.
    if (shown.ownerAddress !== current.owner.address || shown.bindingDigest !== current.bindingDigest || shown.frontendOrigin !== current.frontendOrigin
      || shown.serverAgentId !== current.serverAgentId || shown.chainId !== current.chainId || shown.runnerFingerprint !== current.runnerFingerprint) {
      fail("shown_mismatch");
    }
    if (!privateOwnerSuffixMatches(identity.pairedWallet.address, shown.suffix)) fail("suffix_mismatch");
    const status = this.#wallet(agentId);
    if (status === undefined || status.state === "held") fail("state_unavailable");
    if (status.state === "absent") fail("wallet_missing");
    if (status.state !== "unlocked") fail("wallet_locked");
    const now = (this.#options.now ?? Date.now)();
    if (!isTimestamp(now)) fail("state_unavailable");
    const body: Omit<PinRecord, "mac"> = { schemaVersion: 1, suite: PRIVATE_OWNER_PIN_SUITE, localProfileId: this.#options.localProfileId,
      localAgentId: agentId, serverAgentId: identity.agentId, frontendOrigin: identity.frontendOrigin, tradingWalletAddress: status.address,
      ownerWallet: { chain: identity.pairedWallet.chain, address: identity.pairedWallet.address }, chainId: identity.chainId,
      bindingDigest: identity.bindingDigest, runnerPublicKey: identity.runnerPublicKey, pinnedAt: now };
    let mac: string;
    try { mac = this.#options.keystore.authorityTag(agentId, "owner_pin", pinFields(body)); }
    catch (error: unknown) { const code = privateAuthorityKeystoreCode(error); return fail(code); }
    try {
      this.#records.write(agentId, { ...body, mac });
      const written = this.#records.read(agentId);
      if (!written || written.mac !== mac || written.pinnedAt !== now) fail("write_outcome_unknown");
    } catch (error: unknown) {
      if (error instanceof PrivateOwnerPinError) throw error;
      const code = isRecord(error) ? error.code : undefined;
      return fail(code === "state_unavailable" || code === "closing" ? code : "write_outcome_unknown");
    }
    return this.status(agentId);
  }
  close(): void { this.#records.close(); }

  #wallet(agentId: string): TradingWalletStatus | undefined {
    try { return this.#options.keystore.status(agentId); } catch { return undefined; }
  }
  #decode(value: unknown, agentId: string): PinRecord {
    const keys = ["schemaVersion", "suite", "localProfileId", "localAgentId", "serverAgentId", "frontendOrigin", "tradingWalletAddress", "ownerWallet",
      "chainId", "bindingDigest", "runnerPublicKey", "pinnedAt", "mac"];
    if (!isRecord(value) || Object.keys(value).length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) throw new Error("invalid pin");
    const owner = wallet(value.ownerWallet);
    if (value.schemaVersion !== 1 || value.suite !== PRIVATE_OWNER_PIN_SUITE || value.localProfileId !== this.#options.localProfileId
      || value.localAgentId !== agentId || !isId(value.serverAgentId) || !origin(value.frontendOrigin) || !isSolanaAddress(value.tradingWalletAddress)
      || !owner || !isPrivateOwnerChainId(value.chainId) || typeof value.bindingDigest !== "string" || !HEX.test(value.bindingDigest)
      || typeof value.runnerPublicKey !== "string" || !RUNNER_KEY.test(value.runnerPublicKey) || !isTimestamp(value.pinnedAt)
      || typeof value.mac !== "string" || !HEX.test(value.mac)) throw new Error("invalid pin");
    return { schemaVersion: 1, suite: PRIVATE_OWNER_PIN_SUITE, localProfileId: this.#options.localProfileId, localAgentId: agentId,
      serverAgentId: value.serverAgentId as string, frontendOrigin: value.frontendOrigin as string, tradingWalletAddress: value.tradingWalletAddress as string,
      ownerWallet: owner, chainId: value.chainId, bindingDigest: value.bindingDigest, runnerPublicKey: value.runnerPublicKey,
      pinnedAt: value.pinnedAt as number, mac: value.mac };
  }
}
