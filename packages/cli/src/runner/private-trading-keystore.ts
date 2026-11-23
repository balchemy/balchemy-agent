/** Daemon-owned encrypted Solana trading key: one locally generated (or explicitly
 * imported) hot wallet per agent, never the owner's pairing wallet. Every daemon
 * start is locked; unlock keeps only an Ed25519 KeyObject in this process until
 * lock, hold or close. The secret never enters IPC, status, errors or any file
 * except the sealed envelope. This cannot protect an unlocked process from its OS owner.
 * Keys and slots live in ECMAScript `#private` fields, never TypeScript-only privates. */
import * as fs from "node:fs";
import * as path from "node:path";
import { runnerTradingWalletPossessionMessage, type RunnerTradingWalletExpectedTarget, type RunnerTradingWalletNonce,
  type RunnerTradingWalletTarget } from "@balchemyai/agent-sdk";
import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync,
  randomBytes, scrypt, sign, timingSafeEqual, type KeyObject } from "node:crypto";
import { privateOwned, sameIdentity } from "./kernel-lock.js";
import { OwnedJsonSnapshot } from "./owned-json-snapshot.js";
import { exactKeys, isId, isRecord } from "./protocol.js";
import { decodeBase58, encodeBase58, isSolanaAddress } from "./solana-base58.js";
import { consumeValidatedSolanaMessage, isValidatedSolanaMessage, type ValidatedSolanaMessage } from "./private-solana-validated-message.js";
import { isTradingWalletPassphrase, normalizeTradingWalletPassphrase, parsePrivateTradingWalletRequest, parseTradingWalletEnvelope,
  privateTradingWalletFailure, privateTradingWalletSuccess, tradingWalletAad, tradingWalletChecksum, TRADING_KEYSTORE_SCHEMA_VERSION,
  TRADING_KEYSTORE_SUITE, type PrivateTradingWalletError, type PrivateTradingWalletRequest, type PrivateTradingWalletResponse,
  type TradingWalletEnvelope, type TradingWalletScope, type TradingWalletStatus } from "./private-trading-keystore-protocol.js";
import { addRunnerAgent } from "./agent-roster.js";

const MAX_ENVELOPE_BYTES = 4096;
const MAX_MARKER_BYTES = 1024;
/** One scrypt at a time (N=2^17 needs 128 MiB and a libuv worker); more waiters are refused busy. */
const MAX_PENDING_DERIVATIONS = 4;
const RECORD_NAME = /^trading-wallet-([0-9a-f]{64})\.(json|initialized)$/;
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
/** A2a wrong-passphrase throttle (in memory, per agent, monotonic): five free failures, then each further attempt waits
 * min(2^(n-5) * 2 s, 5 min) after the n-th failure. Reset by a success; never persisted (a same-user attacker could rewrite a counter
 * file, and a restart also locks the wallet). */
const THROTTLE_FREE_FAILURES = 5;
const THROTTLE_BASE_MS = 2_000;
const THROTTLE_MAX_MS = 5 * 60_000;
/** A2a authority tags (owner pin, authority watermark): HKDF-SHA256 from the unlocked seed, then HMAC-SHA256 over a keystore-built tuple. */
const AUTHORITY_SEAL_SALT = createHash("sha256").update("balchemy.local-agent.authority-seal.v1", "utf8").digest();
const AUTHORITY_TAG_DOMAIN = "balchemy.local-agent.authority-tag.v1";
const MAX_AUTHORITY_TAG_FIELDS = 64;
const MAX_AUTHORITY_TAG_FIELD_LENGTH = 16 * 1024;
const AUTHORITY_TAG = /^[0-9a-f]{64}$/;
/** The two fixed purposes; never a generic MAC. */
export type PrivateAuthorityTagPurpose = "owner_pin" | "authority_watermark";
/** The in-process codes: every wire code plus `throttled`, which the private_trading_wallet channel, the socket gate and arming report
 * as `proof_throttled`. */
export type PrivateTradingKeystoreErrorCode = PrivateTradingWalletError | "throttled";
export class PrivateTradingKeystoreError extends Error {
  constructor(readonly code: PrivateTradingKeystoreErrorCode) { super(`Local trading wallet ${code}`); this.name = "PrivateTradingKeystoreError"; }
}
function fail(code: PrivateTradingKeystoreErrorCode): never { throw new PrivateTradingKeystoreError(code); }
function monotonicMs(): number { return Number(process.hrtime.bigint() / 1_000_000n); }
export function tradingWalletFiles(agentId: string): { snapshotFile: string; markerFile: string } {
  const stem = `trading-wallet-${createHash("sha256").update(agentId, "utf8").digest("hex")}`;
  return { snapshotFile: `${stem}.json`, markerFile: `${stem}.initialized` };
}
function exists(filename: string): fs.Stats | undefined {
  try { return fs.lstatSync(filename); }
  catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return undefined; throw error; }
}

/** Ancestors are real directories and the store itself is a private 0700 directory owned by this user. */
function checkDirectory(directory: string): void {
  try {
    let current = path.parse(directory).root;
    for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe ancestor");
    }
    if (!privateOwned(fs.lstatSync(directory), "directory")) throw new Error("unsafe directory");
  } catch { fail("state_unavailable"); }
}
function sameContents(a: fs.Stats, b: fs.Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
/** Read-only, no-follow, private-file JSON read; the file must be unchanged across the read. */
function readOwnedJson(filename: string, maximum: number): { value: unknown; identity: fs.Stats } {
  const named = fs.lstatSync(filename);
  if (!privateOwned(named, "file") || named.size === 0 || named.size > maximum) fail("state_unavailable");
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const bytes = Buffer.alloc(maximum + 1);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!privateOwned(opened, "file") || !sameContents(named, opened)) fail("state_unavailable");
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break; length += count;
    }
    if (length !== opened.size || !sameContents(opened, fs.fstatSync(descriptor)) || !sameContents(opened, fs.lstatSync(filename))) fail("state_unavailable");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const value: unknown = JSON.parse(text);
    if (JSON.stringify(value) !== text) fail("state_unavailable");
    return { value, identity: opened };
  } finally { bytes.fill(0); fs.closeSync(descriptor); }
}
function isMarker(value: unknown, localProfileId: string, agentId: string): boolean {
  return isRecord(value) && exactKeys(value, ["schemaVersion", "localProfileId", "agentId"]) && value.schemaVersion === 1
    && value.localProfileId === localProfileId && value.agentId === agentId;
}

/** Public addresses of every trading wallet record in a runner directory, for refusing a local
 * trading key as a pairing wallet. Read-only: never decrypts, writes, locks or needs the daemon.
 * Any partial, foreign, moved, unsafe or unreadable record throws, so callers fail closed. */
export function readTradingWalletAddresses(directory: string, localProfileId: string): readonly { agentId: string; address: string }[] {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || !isId(localProfileId)) fail("invalid_request");
  const resolved = path.resolve(directory);
  checkDirectory(resolved);
  try {
    const names = fs.readdirSync(resolved);
    const stems = new Set<string>();
    for (const name of names) {
      if (!name.startsWith("trading-wallet-")) continue;
      const match = RECORD_NAME.exec(name);
      if (!match) fail("state_unavailable");
      stems.add(`trading-wallet-${match[1]}`);
    }
    const wallets: { agentId: string; address: string }[] = [];
    for (const stem of [...stems].sort()) {
      if (!names.includes(`${stem}.json`) || !names.includes(`${stem}.initialized`)) fail("state_unavailable");
      const marker = readOwnedJson(path.join(resolved, `${stem}.initialized`), MAX_MARKER_BYTES).value;
      if (!isRecord(marker) || !isId(marker.agentId) || !isMarker(marker, localProfileId, marker.agentId)) fail("state_unavailable");
      const agentId = marker.agentId;
      if (tradingWalletFiles(agentId).snapshotFile !== `${stem}.json`) fail("state_unavailable");
      const envelope = parseTradingWalletEnvelope(readOwnedJson(path.join(resolved, `${stem}.json`), MAX_ENVELOPE_BYTES).value,
        { localProfileId, agentId });
      wallets.push({ agentId, address: envelope.address });
    }
    checkDirectory(resolved);
    return Object.freeze(wallets.map((wallet) => Object.freeze(wallet)));
  } catch (error: unknown) {
    if (error instanceof PrivateTradingKeystoreError) throw error;
    return fail("state_unavailable");
  }
}

async function derive(passphrase: string, salt: string): Promise<Buffer> {
  const password = Buffer.from(normalizeTradingWalletPassphrase(passphrase), "utf8");
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(salt, "base64"), 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
        (error, key) => error ? reject(new PrivateTradingKeystoreError("state_unavailable")) : resolve(key));
    });
  } finally { password.fill(0); }
}
function keyFromSeed(seed: Buffer): KeyObject {
  const der = Buffer.concat([PKCS8_PREFIX, seed]);
  try { return createPrivateKey({ key: der, format: "der", type: "pkcs8" }); }
  finally { der.fill(0); }
}
function publicBytes(key: KeyObject): Buffer {
  const spki = createPublicKey(key).export({ type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519" || spki.length !== SPKI_PREFIX.length + 32
    || !spki.subarray(0, SPKI_PREFIX.length).equals(SPKI_PREFIX)) fail("state_unavailable");
  return Buffer.from(spki.subarray(SPKI_PREFIX.length));
}
/** Authenticated open. A wrong passphrase and a re-addressed header are indistinguishable by design. */
function openSeed(envelope: TradingWalletEnvelope, key: Buffer): Buffer {
  let part: Buffer | undefined; let final: Buffer | undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.nonce, "base64"), { authTagLength: 16 });
    decipher.setAAD(tradingWalletAad(envelope)); decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    part = decipher.update(Buffer.from(envelope.ciphertext, "base64")); final = decipher.final();
    const seed = Buffer.concat([part, final]);
    if (seed.length !== 32) { seed.fill(0); fail("unlock_failed"); }
    return seed;
  } catch { throw new PrivateTradingKeystoreError("unlock_failed"); }
  finally { part?.fill(0); final?.fill(0); }
}

/** Validates a 64-byte Solana secret (seed || public key); the caller owns and zeroes it. */
function checkedSecret(secret: Uint8Array): { seed: Buffer; address: string } {
  if (!(secret instanceof Uint8Array) || secret.length !== 64) fail("invalid_request");
  const seed = Buffer.from(secret.subarray(0, 32));
  try {
    const derived = publicBytes(keyFromSeed(seed));
    if (!derived.equals(Buffer.from(secret.subarray(32)))) fail("invalid_request");
    return { seed, address: encodeBase58(derived) };
  } catch { seed.fill(0); throw new PrivateTradingKeystoreError("invalid_request"); }
}
/** A fresh local hot wallet as the 64-byte seed || public key export. Caller zeroes it. */
export function generateTradingWalletSecret(): Buffer {
  const pair = generateKeyPairSync("ed25519");
  const der = pair.privateKey.export({ type: "pkcs8", format: "der" });
  try {
    if (der.length !== PKCS8_PREFIX.length + 32 || !der.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX)) fail("state_unavailable");
    return Buffer.concat([der.subarray(PKCS8_PREFIX.length), publicBytes(pair.privateKey)]);
  } finally { der.fill(0); }
}
/** Accepts the base58 64-byte export or a solana-keygen JSON byte array. Never echoes input. */
export function parseTradingWalletSecret(text: string): Buffer {
  const value = typeof text === "string" ? text.trim() : "";
  let bytes: Buffer | undefined;
  if (value.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      const items: readonly unknown[] = Array.isArray(parsed) ? parsed : [];
      if (items.length === 64 && items.every((item: unknown) => typeof item === "number" && Number.isInteger(item) && item >= 0 && item <= 255)) {
        bytes = Buffer.from(items as number[]);
      }
    } catch { bytes = undefined; }
  } else bytes = decodeBase58(value, 64);
  if (!bytes) fail("invalid_request");
  const secret: Buffer = bytes;
  try { checkedSecret(secret).seed.fill(0); return secret; }
  catch { secret.fill(0); throw new PrivateTradingKeystoreError("invalid_request"); }
}
export function encodeTradingWalletSecret(secret: Uint8Array): string { checkedSecret(secret).seed.fill(0); return encodeBase58(secret); }
export function tradingWalletAddress(secret: Uint8Array): string { const checked = checkedSecret(secret); checked.seed.fill(0); return checked.address; }

/** Seals in the owner's CLI process; only this envelope is sent to the daemon. */
export async function sealTradingWallet(scope: TradingWalletScope, secret: Uint8Array, passphrase: string): Promise<TradingWalletEnvelope> {
  if (!isRecord(scope) || !isId(scope.localProfileId) || !isId(scope.agentId) || !isTradingWalletPassphrase(passphrase)) fail("invalid_request");
  const { seed, address } = checkedSecret(secret);
  let key: Buffer | undefined; let ciphertext: Buffer | undefined; let reopened: Buffer | undefined;
  try {
    const header = { schemaVersion: TRADING_KEYSTORE_SCHEMA_VERSION, localProfileId: scope.localProfileId, agentId: scope.agentId,
      chain: "solana" as const, address, suite: TRADING_KEYSTORE_SUITE, salt: randomBytes(32).toString("base64"),
      nonce: randomBytes(12).toString("base64") };
    key = await derive(passphrase, header.salt);
    const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"), { authTagLength: 16 });
    cipher.setAAD(tradingWalletAad(header));
    ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
    const sealed = { ...header, ciphertext: ciphertext.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
    const envelope = parseTradingWalletEnvelope({ ...sealed, checksum: tradingWalletChecksum(sealed) }, scope);
    reopened = openSeed(envelope, key);
    if (!reopened.equals(seed)) fail("state_unavailable");
    return envelope;
  } finally { seed.fill(0); key?.fill(0); ciphertext?.fill(0); reopened?.fill(0); }
}

export interface PrivateTradingKeystoreOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this keystore never creates a second lock. */
  assertAvailable(): void;
  /** Public wallet proven at pairing for one local agent; throws when it cannot be confirmed. */
  readPairingWallet(agentId: string): { chain: "solana" | "base"; address: string } | undefined;
  /** The daemon's own adopted identity + current lease for a trading-wallet bind; undefined without an active lease.
   * Without it the possession signer always refuses. */
  readBindingTarget?(agentId: string): Readonly<RunnerTradingWalletTarget & { epoch: number }> | undefined;
  /** Monotonic milliseconds for the wrong-passphrase throttle; a test seam (default: process.hrtime). */
  monotonicNow?(): number;
}
const TARGET_FIELDS = ["frontendOrigin", "agentId", "bindingDigest", "runnerPublicKey", "instanceId", "epoch"] as const;
const POSSESSION_PURPOSE = "balchemy.local-agent.trading-wallet.possession.v1";
/** Own enumerable data properties exactly equal to `keys`; never invokes an accessor. */
function plainExact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const fields = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).length === keys.length && keys.every((key) => Object.hasOwn(fields, key))
    && Object.values(fields).every((field) => "value" in field && field.enumerable);
}
/** `verified`: this daemon run decrypted the envelope and derived its address. Reset by hold or restart. */
type Slot = { kind: "held" }
  | { kind: "open"; storage: OwnedJsonSnapshot<TradingWalletEnvelope | null>; envelope: TradingWalletEnvelope; key?: KeyObject; verified: boolean };

export class PrivateTradingKeystore {
  readonly #options: PrivateTradingKeystoreOptions;
  readonly #agentIds: string[];
  readonly #directory: string;
  readonly #slots = new Map<string, Slot>();
  readonly #active = new Set<string>();
  /** Lock, hold and lost availability advance this; an in-flight unlock from an older generation never installs. */
  readonly #generations = new Map<string, number>();
  readonly #work = new Set<Promise<unknown>>();
  readonly #abort = new AbortController();
  #derivations: Promise<void> = Promise.resolve();
  #pendingDerivations = 0;
  /** Wrong-passphrase failures per agent and the monotonic time before which unlock and verify refuse `throttled`. */
  readonly #failures = new Map<string, { count: number; until: number }>();
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(options: PrivateTradingKeystoreOptions) {
    if (!isRecord(options) || !isId(options.localProfileId) || !Array.isArray(options.agentIds) || options.agentIds.length < 1
      || options.agentIds.length > 64 || options.agentIds.some((id) => !isId(id)) || new Set(options.agentIds).size !== options.agentIds.length
      || typeof options.assertAvailable !== "function" || typeof options.readPairingWallet !== "function"
      || (options.monotonicNow !== undefined && typeof options.monotonicNow !== "function")
      || typeof options.directory !== "string" || !path.isAbsolute(options.directory)) fail("invalid_request");
    this.#agentIds = [...options.agentIds]; this.#options = { ...options, agentIds: this.#agentIds };
    this.#directory = path.resolve(options.directory);
    checkDirectory(this.#directory);
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.#agentIds, agentId); }

  /** Address + state only. A new agent's status never creates a file. */
  status(agentId: string): TradingWalletStatus { this.#available(); this.#agent(agentId); return this.#view(agentId); }

  /** Read-only: refuses before the CLI generates, accepts or shows any secret. Checks this agent,
   * every peer record and every pairing record (and, with an address, duplicates and pairing wallets). */
  preflight(agentId: string, address?: string): TradingWalletStatus {
    this.#available(); this.#agent(agentId);
    if (address !== undefined && !isSolanaAddress(address)) fail("invalid_request");
    if (this.#active.has(agentId)) fail("busy");
    this.#preconditions(agentId, address);
    return { state: "absent" };
  }

  /** Installs a CLI-sealed envelope once. Never replaces an existing or held wallet. Every refusal
   * before the write leaves no file; a failure from the write on is `write_outcome_unknown`. */
  install(agentId: string, input: unknown): TradingWalletStatus {
    this.#available(); this.#agent(agentId);
    let envelope: TradingWalletEnvelope;
    try { envelope = parseTradingWalletEnvelope(input, { localProfileId: this.#options.localProfileId, agentId }); }
    catch { return fail("invalid_request"); }
    if (this.#active.has(agentId)) fail("busy");
    this.#active.add(agentId);
    try {
      this.#preconditions(agentId, envelope.address);
      if (this.#open(agentId, envelope).kind !== "open") fail("write_outcome_unknown");
      const view = this.#view(agentId);
      if (view.state !== "locked" || view.address !== envelope.address) fail("write_outcome_unknown");
      return view;
    } finally { this.#active.delete(agentId); }
  }

  unlock(agentId: string, passphrase: string, signal?: AbortSignal): Promise<TradingWalletStatus> {
    const work = this.#unlocking(agentId, passphrase, signal);
    this.#work.add(work);
    void work.then(() => this.#work.delete(work), () => this.#work.delete(work));
    return work;
  }

  /** Arming re-entry check (S8a): derives this wallet's key from `passphrase`, authenticates the sealed envelope with it
   * and compares the decrypted key's public bytes to the unlocked key's in constant time, then discards everything. The
   * passphrase is never stored; the unlocked key and the envelope are not changed. Requires an unlocked wallet. A wrong
   * passphrase is `unlock_failed`. Same serialized scrypt queue and fencing as unlock. */
  verifyPassphrase(agentId: string, passphrase: string, signal?: AbortSignal): Promise<true> {
    const work = this.#verifying(agentId, passphrase, signal);
    this.#work.add(work);
    void work.then(() => this.#work.delete(work), () => this.#work.delete(work));
    return work;
  }

  /** Clears the in-memory key and fences an in-flight unlock before any other check, so it
   * works while the store is held or unavailable; then every key is dropped on lost availability. */
  lock(agentId: string): TradingWalletStatus {
    if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent");
    this.#fence(agentId);
    const slot = this.#slots.get(agentId);
    if (slot?.kind === "open") slot.key = undefined;
    this.#available();
    return this.#view(agentId);
  }

  /** Owner-confirmed recovery of an interrupted create: removes only this agent's
   * initialization marker, and only when no envelope or in-flight temporary exists.
   * It never deletes, moves or rewrites an envelope. */
  recover(agentId: string): TradingWalletStatus {
    this.#available(); this.#agent(agentId);
    if (this.#active.has(agentId)) fail("busy");
    this.#active.add(agentId);
    try {
      if (this.#slots.get(agentId)?.kind === "open") fail("recovery_refused");
      const files = tradingWalletFiles(agentId);
      const markerPath = path.join(this.#directory, files.markerFile);
      const orphan = (): fs.Stats => {
        checkDirectory(this.#directory);
        try {
          if (exists(path.join(this.#directory, files.snapshotFile))
            || fs.readdirSync(this.#directory).some((name) => name.startsWith(`.${files.snapshotFile}-`))) fail("recovery_refused");
          if (!exists(markerPath)) fail("recovery_refused");
          const marker = readOwnedJson(markerPath, MAX_MARKER_BYTES);
          if (!isMarker(marker.value, this.#options.localProfileId, agentId)) fail("recovery_refused");
          return marker.identity;
        } catch (error: unknown) {
          if (error instanceof PrivateTradingKeystoreError) throw error;
          return fail("state_unavailable");
        }
      };
      const identity = orphan();
      this.#available();
      if (!sameContents(orphan(), identity)) fail("state_unavailable");
      // From the unlink on, a failure leaves the outcome unknown; nothing else is touched.
      try {
        fs.unlinkSync(markerPath);
        const descriptor = fs.openSync(this.#directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      } catch { this.#hold(agentId); return fail("write_outcome_unknown"); }
      this.#slots.delete(agentId); this.#fence(agentId);
      const view = this.#view(agentId);
      if (view.state !== "absent") fail("write_outcome_unknown");
      return view;
    } finally { this.#active.delete(agentId); }
  }

  /** The only signing entry point: an S2-minted, unspent validated message bound to this agent
   * and this wallet's address. Never raw bytes; the token is spent on use. */
  sign(agentId: string, message: ValidatedSolanaMessage): Buffer {
    if (!isValidatedSolanaMessage(message)) fail("invalid_request");
    this.#available(); this.#agent(agentId);
    const slot = this.#slot(agentId);
    if (!slot || slot.kind !== "open") fail(slot ? "state_unavailable" : "wallet_missing");
    if (!slot.key || !slot.verified) fail("wallet_locked");
    const bytes = consumeValidatedSolanaMessage(message, { agentId, signerAddress: slot.envelope.address });
    try {
      if (!bytes) fail("invalid_request");
      return sign(null, bytes, slot.key);
    } finally { bytes?.fill(0); }
  }

  /** The trading key's only non-transaction signature: the SDK's fixed-purpose possession message for a trading-wallet
   * bind of this agent's own verified address, the daemon's independently read lease target and an unexpired nonce.
   * Every expected field is compared first; the SDK helper then re-validates the nonce against the daemon's copy and
   * derives the bytes. Caller bytes are never signed, and this never accepts or produces a Solana message. */
  signBindingPossession(agentId: string, nonce: Readonly<RunnerTradingWalletNonce>, expected: RunnerTradingWalletExpectedTarget): string {
    this.#available(); this.#agent(agentId);
    const slot = this.#slot(agentId);
    if (!slot || slot.kind !== "open") fail(slot ? "state_unavailable" : "wallet_missing");
    if (!slot.key || !slot.verified) fail("wallet_locked");
    const address = slot.envelope.address;
    let read: { target: ReturnType<NonNullable<PrivateTradingKeystoreOptions["readBindingTarget"]>>;
      pairing: ReturnType<PrivateTradingKeystoreOptions["readPairingWallet"]> };
    try { read = { target: this.#options.readBindingTarget?.(agentId), pairing: this.#options.readPairingWallet(agentId) }; }
    catch { return fail("state_unavailable"); }
    const { target: current, pairing } = read;
    if (!current) return fail("state_unavailable");
    const target = current;
    if (pairing?.chain === "solana" && pairing.address === address) fail("pairing_wallet");
    if (!plainExact(expected, [...TARGET_FIELDS, "request"]) || !plainExact(expected.request, ["version", "chain", "walletAddress"])
      || expected.request.version !== 1 || expected.request.chain !== "solana" || expected.request.walletAddress !== address
      || TARGET_FIELDS.some((key) => expected[key] !== target[key])) fail("invalid_request");
    const pinned: RunnerTradingWalletExpectedTarget = { frontendOrigin: target.frontendOrigin, agentId: target.agentId,
      bindingDigest: target.bindingDigest, runnerPublicKey: target.runnerPublicKey, instanceId: target.instanceId, epoch: target.epoch,
      request: { version: 1, chain: "solana", walletAddress: address } };
    let message: string;
    try { message = runnerTradingWalletPossessionMessage(nonce, pinned); } catch { return fail("invalid_request"); }
    // Defense in depth: the derived tuple names exactly this purpose, target and address.
    let tuple: unknown;
    try { tuple = JSON.parse(message); } catch { return fail("invalid_request"); }
    if (!Array.isArray(tuple) || tuple.length !== 12 || tuple[0] !== POSSESSION_PURPOSE || tuple[3] !== pinned.agentId
      || tuple[4] !== pinned.bindingDigest || tuple[5] !== pinned.runnerPublicKey || tuple[6] !== pinned.instanceId
      || tuple[7] !== pinned.epoch || tuple[8] !== address) fail("invalid_request");
    this.#available();
    if (this.#slot(agentId) !== slot || !slot.key) fail("wallet_locked");
    return sign(null, Buffer.from(message, "utf8"), slot.key).toString("base64");
  }

  /** A2a: the purpose-fixed authority tag of this agent's unlocked wallet (owner pin or authority watermark). The key is derived on
   * demand (HKDF-SHA256 over the unlocked seed, salt sha256("balchemy.local-agent.authority-seal.v1"), info [purpose, localProfileId,
   * agentId, wallet address]) and zeroed after use; nothing extra is kept. The keystore frames the caller's ordered string fields
   * into its own tuple [domain, purpose, localProfileId, agentId, address, ...fields]. An `owner_pin` tuple must start with this
   * wallet's address. Locked: `wallet_locked`; no wallet: `wallet_missing`; a held record: `state_unavailable`. Hex, 64 characters. */
  authorityTag(agentId: string, purpose: PrivateAuthorityTagPurpose, fields: readonly string[]): string {
    const { slot, message } = this.#tagInput(agentId, purpose, fields);
    if (purpose === "owner_pin" && fields[0] !== slot.envelope.address) fail("invalid_request");
    return this.#tag(agentId, purpose, slot, message);
  }
  /** Constant-time check of a stored tag. Same refusals as `authorityTag` for a locked, missing or held wallet; a malformed tag, an
   * owner pin of another wallet address or any field difference is `false`. */
  verifyAuthorityTag(agentId: string, purpose: PrivateAuthorityTagPurpose, fields: readonly string[], tag: string): boolean {
    const { slot, message } = this.#tagInput(agentId, purpose, fields);
    if (typeof tag !== "string" || !AUTHORITY_TAG.test(tag) || (purpose === "owner_pin" && fields[0] !== slot.envelope.address)) return false;
    const expected = Buffer.from(this.#tag(agentId, purpose, slot, message), "hex"); const given = Buffer.from(tag, "hex");
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async handle(input: PrivateTradingWalletRequest, signal?: AbortSignal): Promise<PrivateTradingWalletResponse> {
    const request = parsePrivateTradingWalletRequest(input);
    try {
      if (request.localProfileId !== this.#options.localProfileId) return privateTradingWalletFailure(request, "profile_conflict");
      if (!this.#options.agentIds.includes(request.agentId)) return privateTradingWalletFailure(request, "unknown_agent");
      const wallet = request.action === "status" ? this.status(request.agentId)
        : request.action === "lock" ? this.lock(request.agentId)
          : request.action === "preflight" ? this.preflight(request.agentId, "address" in request ? request.address : undefined)
            : request.action === "recover" ? this.recover(request.agentId)
              : request.action === "create" ? this.install(request.agentId, request.envelope)
                : await this.unlock(request.agentId, request.passphrase, signal);
      return privateTradingWalletSuccess(request, wallet);
    } catch (error: unknown) {
      // An unexpected failure during a mutation may follow a durable write; it is never reported as a refusal.
      const unexpected = request.action === "create" || request.action === "recover" ? "write_outcome_unknown" : "state_unavailable";
      // A2a T2: a throttled unlock is `proof_throttled` on this channel (the socket gate and arming use the same code).
      const raw: PrivateTradingKeystoreErrorCode = error instanceof PrivateTradingKeystoreError ? error.code : unexpected;
      const code: PrivateTradingWalletError = raw === "throttled" ? "proof_throttled" : raw;
      return privateTradingWalletFailure(request, code);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true; this.#abort.abort();
    for (const slot of this.#slots.values()) if (slot.kind === "open") slot.key = undefined;
    this.#closePromise = Promise.allSettled([...this.#work]).then(() => {
      for (const slot of this.#slots.values()) if (slot.kind === "open") { slot.key = undefined; slot.storage.close(); }
      this.#slots.clear();
    });
    return this.#closePromise;
  }

  async #unlocking(agentId: string, passphrase: string, signal?: AbortSignal): Promise<TradingWalletStatus> {
    this.#available(); this.#agent(agentId);
    if (!isTradingWalletPassphrase(passphrase)) fail("invalid_request");
    if (this.#active.has(agentId)) fail("busy");
    this.#active.add(agentId);
    let key: Buffer | undefined; let seed: Buffer | undefined;
    try {
      const slot = this.#slot(agentId);
      if (!slot) fail("wallet_missing");
      if (slot.kind !== "open") fail("state_unavailable");
      if (slot.key) return this.#view(agentId);
      this.#throttled(agentId);
      const generation = this.#generations.get(agentId) ?? 0;
      const guard = (): void => {
        if (this.#closed) fail("closing");
        if (signal?.aborted || this.#abort.signal.aborted || (this.#generations.get(agentId) ?? 0) !== generation) fail("cancelled");
        this.#available();
        if (this.#slot(agentId) !== slot) fail("state_unavailable");
      };
      key = await this.#derive(passphrase, slot.envelope.salt, guard);
      guard();
      // Only an authenticated-open failure after a completed derivation counts toward the throttle (never busy or cancelled).
      seed = this.#openCounted(agentId, slot.envelope, key);
      const privateKey = keyFromSeed(seed);
      // Authenticated, yet not the bound address: the record is inconsistent, never a usable key.
      if (encodeBase58(publicBytes(privateKey)) !== slot.envelope.address) { this.#hold(agentId); fail("state_unavailable"); }
      guard();
      slot.key = privateKey; slot.verified = true;
      this.#failures.delete(agentId);
      return this.#view(agentId);
    } finally { key?.fill(0); seed?.fill(0); this.#active.delete(agentId); }
  }
  async #verifying(agentId: string, passphrase: string, signal?: AbortSignal): Promise<true> {
    this.#available(); this.#agent(agentId);
    if (!isTradingWalletPassphrase(passphrase)) fail("unlock_failed");
    if (this.#active.has(agentId)) fail("busy");
    this.#active.add(agentId);
    let key: Buffer | undefined; let opened: Buffer | undefined; let derived: Buffer | undefined; let unlocked: Buffer | undefined;
    try {
      const slot = this.#slot(agentId);
      if (!slot) fail("wallet_missing");
      if (slot.kind !== "open") fail("state_unavailable");
      if (!slot.key || !slot.verified) fail("wallet_locked");
      this.#throttled(agentId);
      const generation = this.#generations.get(agentId) ?? 0;
      const guard = (): void => {
        if (this.#closed) fail("closing");
        if (signal?.aborted || this.#abort.signal.aborted || (this.#generations.get(agentId) ?? 0) !== generation) fail("cancelled");
        this.#available();
        if (this.#slot(agentId) !== slot || !slot.key) fail("wallet_locked");
      };
      key = await this.#derive(passphrase, slot.envelope.salt, guard);
      guard();
      try {
        // AES-GCM tag verification authenticates the passphrase-derived key; a wrong passphrase fails here (unlock_failed).
        opened = openSeed(slot.envelope, key);
        derived = publicBytes(keyFromSeed(opened));
        const current = slot.key;
        if (!current) fail("wallet_locked");
        unlocked = publicBytes(current);
        if (derived.length !== unlocked.length || !timingSafeEqual(derived, unlocked)) fail("unlock_failed");
      } catch (error: unknown) { this.#counted(agentId, error); throw error; }
      guard();
      this.#failures.delete(agentId);
      return true;
    } finally { key?.fill(0); opened?.fill(0); derived?.fill(0); unlocked?.fill(0); this.#active.delete(agentId); }
  }
  /** Refuses `throttled` while this agent's wait after its last counted failure has not passed. Never derives. */
  #throttled(agentId: string): void {
    const entry = this.#failures.get(agentId);
    if (entry && (this.#options.monotonicNow ?? monotonicMs)() < entry.until) fail("throttled");
  }
  /** Counts one wrong passphrase (an `unlock_failed` after a completed derivation); anything else is not counted. */
  #counted(agentId: string, error: unknown): void {
    if (!(error instanceof PrivateTradingKeystoreError) || error.code !== "unlock_failed") return;
    const count = (this.#failures.get(agentId)?.count ?? 0) + 1;
    const wait = count < THROTTLE_FREE_FAILURES ? 0
      : Math.min(2 ** Math.min(count - THROTTLE_FREE_FAILURES, 20) * THROTTLE_BASE_MS, THROTTLE_MAX_MS);
    this.#failures.set(agentId, { count, until: (this.#options.monotonicNow ?? monotonicMs)() + wait });
  }
  #openCounted(agentId: string, envelope: TradingWalletEnvelope, key: Buffer): Buffer {
    try { return openSeed(envelope, key); } catch (error: unknown) { this.#counted(agentId, error); throw error; }
  }
  /** Checks and frames one authority-tag request; the slot must be open, unlocked and verified in this run. */
  #tagInput(agentId: string, purpose: PrivateAuthorityTagPurpose, fields: readonly string[]): { slot: Extract<Slot, { kind: "open" }>; message: Buffer } {
    this.#available(); this.#agent(agentId);
    if ((purpose !== "owner_pin" && purpose !== "authority_watermark") || !Array.isArray(fields) || fields.length < 1
      || fields.length > MAX_AUTHORITY_TAG_FIELDS || fields.some((item: unknown) => typeof item !== "string" || item.length > MAX_AUTHORITY_TAG_FIELD_LENGTH
        || Buffer.from(item, "utf8").toString("utf8") !== item)) fail("invalid_request");
    const slot = this.#slot(agentId);
    if (!slot || slot.kind !== "open") fail(slot ? "state_unavailable" : "wallet_missing");
    if (!slot.key || !slot.verified) fail("wallet_locked");
    const message = Buffer.from(JSON.stringify([AUTHORITY_TAG_DOMAIN, purpose, this.#options.localProfileId, agentId, slot.envelope.address,
      ...fields]), "utf8");
    return { slot, message };
  }
  /** HKDF from the seed re-exported from the unlocked key (pkcs8), then HMAC; the DER, the seed and the derived key are zeroed. */
  #tag(agentId: string, purpose: PrivateAuthorityTagPurpose, slot: Extract<Slot, { kind: "open" }>, message: Buffer): string {
    const current = slot.key;
    if (!current) fail("wallet_locked");
    const der = current.export({ type: "pkcs8", format: "der" });
    let derived: Buffer | undefined;
    try {
      if (der.length !== PKCS8_PREFIX.length + 32 || !der.subarray(0, PKCS8_PREFIX.length).equals(PKCS8_PREFIX)) fail("state_unavailable");
      const info = Buffer.from(JSON.stringify([purpose, this.#options.localProfileId, agentId, slot.envelope.address]), "utf8");
      derived = Buffer.from(hkdfSync("sha256", der.subarray(PKCS8_PREFIX.length), AUTHORITY_SEAL_SALT, info, 32));
      return createHmac("sha256", derived).update(message).digest("hex");
    } finally { der.fill(0); derived?.fill(0); message.fill(0); }
  }
  /** Serializes scrypt across agents. A waiter cancelled or fenced while queued never derives. */
  async #derive(passphrase: string, salt: string, guard: () => void): Promise<Buffer> {
    if (this.#pendingDerivations >= MAX_PENDING_DERIVATIONS) fail("busy");
    this.#pendingDerivations++;
    const previous = this.#derivations;
    let release: () => void = () => undefined;
    this.#derivations = new Promise<void>((resolve) => { release = resolve; });
    try {
      await previous;
      guard();
      return await derive(passphrase, salt);
    } finally { this.#pendingDerivations--; release(); }
  }
  /** Address + state; a locked address stays unverified until this run's unlock succeeded. */
  #view(agentId: string): TradingWalletStatus {
    const slot = this.#slot(agentId);
    if (!slot) return { state: "absent" };
    if (slot.kind === "held") return { state: "held" };
    return slot.key && slot.verified ? { state: "unlocked", address: slot.envelope.address, addressVerified: true }
      : { state: "locked", address: slot.envelope.address, addressVerified: slot.verified };
  }
  /** Every install precondition. Reads only; any held peer or unconfirmed pairing record refuses. */
  #preconditions(agentId: string, address: string | undefined): void {
    const current = this.#view(agentId);
    if (current.state === "held") fail("state_unavailable");
    if (current.state !== "absent") fail("wallet_exists");
    for (const other of this.#options.agentIds) {
      if (other !== agentId) {
        const peer = this.#view(other);
        if (peer.state === "held") fail("state_unavailable");
        if (address !== undefined && peer.state !== "absent" && peer.address === address) fail("duplicate_wallet");
      }
      let pairing: ReturnType<PrivateTradingKeystoreOptions["readPairingWallet"]>;
      try { pairing = this.#options.readPairingWallet(other); } catch { return fail("state_unavailable"); }
      if (address !== undefined && pairing?.chain === "solana" && pairing.address === address) fail("pairing_wallet");
    }
    this.#available();
  }
  /** Lazily opens one agent's envelope. Any partial, foreign, corrupt or moved record is held. */
  #slot(agentId: string): Slot | undefined {
    const current = this.#slots.get(agentId);
    if (current?.kind === "held") return current;
    if (current) {
      try { current.storage.assertAvailable(); return current; }
      catch { return this.#hold(agentId); }
    }
    checkDirectory(this.#directory);
    const files = tradingWalletFiles(agentId);
    try {
      if (!exists(path.join(this.#directory, files.markerFile)) && !exists(path.join(this.#directory, files.snapshotFile))) return undefined;
    } catch { return this.#hold(agentId); }
    return this.#open(agentId);
  }
  /** With `initial`, an absent record is created: marker + fsync + directory fsync, then
   * temporary file + fsync + rename + directory fsync. Without it, absent stays unwritten. */
  #open(agentId: string, initial?: TradingWalletEnvelope): Slot {
    const scope = { localProfileId: this.#options.localProfileId, agentId };
    let storage: OwnedJsonSnapshot<TradingWalletEnvelope | null> | undefined;
    try {
      storage = new OwnedJsonSnapshot<TradingWalletEnvelope | null>({ directory: this.#directory, ...tradingWalletFiles(agentId),
        marker: { schemaVersion: 1, localProfileId: scope.localProfileId, agentId }, maximumBytes: MAX_ENVELOPE_BYTES,
        initial: initial ?? null, assertAvailable: this.#options.assertAvailable,
        decode: (value) => parseTradingWalletEnvelope(value, scope) });
      const envelope = storage.read();
      if (!envelope || (initial && JSON.stringify(envelope) !== JSON.stringify(initial))) throw new Error("unexpected envelope");
      const slot: Slot = { kind: "open", storage, envelope, verified: false };
      this.#slots.set(agentId, slot);
      return slot;
    } catch {
      try { storage?.close(); } catch { /* Preserve files; no detail leaves this boundary. */ }
      return this.#hold(agentId);
    }
  }
  #hold(agentId: string): Slot {
    const current = this.#slots.get(agentId);
    if (current?.kind === "open") { current.key = undefined; try { current.storage.close(); } catch { /* Held regardless. */ } }
    this.#fence(agentId);
    const held: Slot = { kind: "held" };
    this.#slots.set(agentId, held);
    return held;
  }
  #fence(agentId: string): void { this.#generations.set(agentId, (this.#generations.get(agentId) ?? 0) + 1); }
  /** Lost writer authority drops every in-memory key and fences every in-flight unlock. */
  #dropKeys(): void {
    for (const slot of this.#slots.values()) if (slot.kind === "open") slot.key = undefined;
    for (const agentId of this.#options.agentIds) this.#fence(agentId);
  }
  #agent(agentId: string): void { if (!isId(agentId) || !this.#options.agentIds.includes(agentId)) fail("unknown_agent"); }
  #available(): void {
    if (this.#closed) { this.#dropKeys(); fail("closing"); }
    try { this.#options.assertAvailable(); } catch { this.#dropKeys(); fail("state_unavailable"); }
  }
}
