import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import {
  RunnerPairingClient, pairingBindingDigest, runnerPairingReadMessage, validateRunnerPairingBinding,
  validateRunnerPairingResponse, type LocalAgentPairingBindingV1,
  type RunnerPairingChallenge, type RunnerPairingReadNonce, type RunnerPairingReceipt,
  runnerRuntimeNonceMessage, type RunnerRuntimeActionBody, type RunnerRuntimeNonce,
  runnerControlNonceMessage, type RunnerControlOperation, type RunnerControlNonce,
  runnerResearchNonceMessage, type RunnerResearchRequest, type RunnerResearchNonce,
  runnerSignalsNonceMessage, type RunnerSignalsRequest, type RunnerSignalsNonce,
  runnerDecisionReportNonceMessage, type RunnerDecisionReport, type RunnerDecisionReportNonce,
  runnerAssessmentNonceMessage, type RunnerAssessmentRequest, type RunnerAssessmentNonce,
  runnerTradingWalletNonceMessage, type RunnerTradingWalletRequest, type RunnerTradingWalletNonce,
  runnerExecutionNonceMessage, type RunnerExecutionBuyRequest, type RunnerExecutionNonce, type RunnerExitRequest,
  runnerSellAssessmentNonceMessage, type RunnerSellAssessmentRequest, type RunnerSellAssessmentNonce,
  runnerExecutionSubmitNonceMessage, type RunnerExecutionSubmitRequest, type RunnerExecutionSubmitNonce,
  runnerExecutionStatusNonceMessage, type RunnerExecutionStatusRequest, type RunnerExecutionStatusNonce,
  runnerLaunchpadSubscriptionsNonceMessage, type RunnerLaunchpadSubscriptionsRequest, type RunnerLaunchpadSubscriptionsNonce,
  runnerFirstEnableNonceMessage, type RunnerFirstEnableRequest, type RunnerFirstEnableNonce,
  runnerFirstEnableReadNonceMessage, type RunnerFirstEnableReadRequest, type RunnerFirstEnableReadNonce,
  runnerCeilingReadNonceMessage, type RunnerCeilingReadRequest, type RunnerCeilingReadNonce,
  runnerRpcAccessNonceMessage, type RunnerRpcAccessNonce,
} from "@balchemyai/agent-sdk";
import { PROFILE_FILE } from "./metadata.js";
import { exactKeys, isId, isRecord } from "./protocol.js";
import { readTradingWalletAddresses } from "./private-trading-keystore.js";

export interface PairingIdentityOptions { directory: string; localProfileId: string; agentId: string }
/** A local identity proposal, never a pairing receipt or execution authority. */
export interface PairingIdentityDescriptor {
  version: 1;
  runnerPublicKey: string;
  localIntentNonce: string;
  pairing: "unpaired";
  execution: "unavailable";
}
export interface PairingApproval { frontendOrigin: string; challengeId: string; bindingDigest: string; expiresAt: string }
export interface PairingAdoption {
  frontendOrigin: string;
  agentId: string;
  pairedAt: string;
  pairing: "paired";
  execution: "unavailable";
}
/** Public runtime identity, available only after durable receipt adoption. */
export interface PairedRunnerDescriptor {
  frontendOrigin: string;
  agentId: string;
  bindingDigest: string;
  runnerPublicKey: string;
}
interface ApprovalRecord {
  schemaVersion: 1;
  frontendOrigin: string;
  binding: LocalAgentPairingBindingV1;
  bindingDigest: string;
}
interface AdoptionRecord { schemaVersion: 1; frontendOrigin: string; receipt: RunnerPairingReceipt }
type Stage = "approval" | "adoption";

export class PairingIdentityError extends Error {
  constructor(readonly code: "invalid_options" | "unsafe_path" | "identity_locked" | "identity_unavailable" | "trading_wallet") {
    super(`Local runner ${code}`);
    this.name = "PairingIdentityError";
  }
}

interface IdentityRecord {
  schemaVersion: 1;
  localProfileId: string;
  agentId: string;
  runnerPublicKey: string;
  localIntentNonce: string;
  privateKey: string;
}
interface Location {
  directory: string;
  descriptor: number;
  identity: fs.Stats;
  options: PairingIdentityOptions;
  stem: string;
}

const MAX_RECORD_BYTES = 2048;
const MAX_BINDING_BYTES = 4096;
const PRIVATE_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PUBLIC_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function unavailable(): never { throw new PairingIdentityError("identity_unavailable"); }
function owned(stat: fs.Stats, directory: boolean): boolean {
  return (directory ? stat.isDirectory() : stat.isFile()) && !stat.isSymbolicLink()
    && (stat.mode & 0o7777) === (directory ? 0o700 : 0o600)
    && (directory || stat.nlink === 1) && (!process.getuid || stat.uid === process.getuid());
}
function sameFile(a: fs.Stats, b: fs.Stats): boolean { return a.ino === b.ino && a.dev === b.dev; }
function inspect(file: string): fs.Stats | undefined {
  try { return fs.lstatSync(file); }
  catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return undefined; throw error; }
}

// Existing helpers create directories or read through paths after lstat. This
// identity boundary instead opens without following links and validates the fd.
function checkAncestors(directory: string): void {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = inspect(current);
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new PairingIdentityError("unsafe_path");
  }
}
function checkLocation(location: Location): void {
  checkAncestors(location.directory);
  const stat = fs.lstatSync(location.directory);
  if (!owned(stat, true) || !sameFile(stat, location.identity)
    || !sameFile(fs.fstatSync(location.descriptor), location.identity)) throw new PairingIdentityError("unsafe_path");
}

function readJson(location: Location, file: string, maximum = MAX_RECORD_BYTES): unknown {
  checkLocation(location);
  let descriptor: number | undefined;
  const bytes = Buffer.alloc(maximum + 1);
  try {
    const before = fs.lstatSync(file);
    if (!owned(before, false) || before.size === 0 || before.size > maximum) unavailable();
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(descriptor);
    if (!owned(opened, false) || !sameFile(before, opened)) unavailable();
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fs.fstatSync(descriptor);
    const named = fs.lstatSync(file);
    if (length !== opened.size || length > maximum || !owned(after, false) || !owned(named, false)
      || !sameFile(opened, named) || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) unavailable();
    checkLocation(location);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
    const value: unknown = JSON.parse(text);
    // Our records are canonical; reject duplicate keys and trailing material.
    if (JSON.stringify(value) !== text) unavailable();
    return value;
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function checkProfile(location: Location): void {
  const value = readJson(location, path.join(location.directory, PROFILE_FILE));
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "pairing"])
    || value.schemaVersion !== 1 || value.localProfileId !== location.options.localProfileId
    || value.pairing !== "unpaired") unavailable();
}

function withLocation<T>(options: PairingIdentityOptions, allowMissing: boolean, action: (location: Location) => T): T | undefined {
  if (!isRecord(options) || !exactKeys(options, ["directory", "localProfileId", "agentId"])
    || typeof options.directory !== "string" || options.directory.length === 0 || options.directory.includes("\0")
    || !isId(options.localProfileId) || !isId(options.agentId)) throw new PairingIdentityError("invalid_options");
  let descriptor: number | undefined;
  try {
    const directory = path.resolve(options.directory);
    if (!inspect(directory)) {
      // Check existing parents, even for a probe of a missing directory.
      let parent = path.dirname(directory);
      while (!inspect(parent)) parent = path.dirname(parent);
      checkAncestors(parent);
      if (allowMissing) return undefined;
      unavailable();
    }
    checkAncestors(directory);
    const identity = fs.lstatSync(directory);
    if (!owned(identity, true)) throw new PairingIdentityError("unsafe_path");
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const location: Location = {
      directory, descriptor, identity, options,
      stem: path.join(directory, `pairing-${createHash("sha256").update(options.agentId).digest("hex")}`),
    };
    checkLocation(location);
    checkProfile(location);
    return action(location);
  } catch (error: unknown) {
    if (error instanceof PairingIdentityError) throw error;
    throw new PairingIdentityError("identity_unavailable");
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* No private data in diagnostics. */ }
    }
  }
}

function decodeRecord(value: unknown, options: PairingIdentityOptions): IdentityRecord {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "agentId", "runnerPublicKey", "localIntentNonce", "privateKey"])
    || value.schemaVersion !== 1 || value.localProfileId !== options.localProfileId || value.agentId !== options.agentId
    || typeof value.localIntentNonce !== "string" || !/^[0-9a-f]{64}$/.test(value.localIntentNonce)
    || typeof value.runnerPublicKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value.runnerPublicKey)
    || typeof value.privateKey !== "string" || !/^[A-Za-z0-9+/]{64}$/.test(value.privateKey)) unavailable();
  const publicBytes = Buffer.from(value.runnerPublicKey, "base64");
  const privateBytes = Buffer.from(value.privateKey, "base64");
  try {
    if (publicBytes.length !== 32 || publicBytes.toString("base64") !== value.runnerPublicKey
      || privateBytes.length !== 48 || privateBytes.toString("base64") !== value.privateKey
      || !privateBytes.subarray(0, PRIVATE_PREFIX.length).equals(PRIVATE_PREFIX)) unavailable();
    const key = createPrivateKey({ key: privateBytes, type: "pkcs8", format: "der" });
    const derived = createPublicKey(key).export({ type: "spki", format: "der" });
    if (key.asymmetricKeyType !== "ed25519" || derived.length !== PUBLIC_PREFIX.length + 32
      || !derived.subarray(0, PUBLIC_PREFIX.length).equals(PUBLIC_PREFIX)
      || !derived.subarray(PUBLIC_PREFIX.length).equals(publicBytes)) unavailable();
    return value as unknown as IdentityRecord;
  } finally { privateBytes.fill(0); }
}
function descriptorOf(record: IdentityRecord): PairingIdentityDescriptor {
  return { version: 1, runnerPublicKey: record.runnerPublicKey, localIntentNonce: record.localIntentNonce,
    pairing: "unpaired", execution: "unavailable" };
}

function readRecord(location: Location): IdentityRecord | undefined {
  const initialized = inspect(`${location.stem}.initialized`);
  const stored = inspect(`${location.stem}.json`);
  if (!initialized && !stored) return undefined;
  if (!initialized || !stored) unavailable();
  const marker = readJson(location, `${location.stem}.initialized`);
  if (!isRecord(marker) || !exactKeys(marker, ["schemaVersion", "localProfileId", "agentId"])
    || marker.schemaVersion !== 1 || marker.localProfileId !== location.options.localProfileId
    || marker.agentId !== location.options.agentId) unavailable();
  return decodeRecord(readJson(location, `${location.stem}.json`), location.options);
}

function writeNew(location: Location, filename: string, value: unknown, maximum = MAX_RECORD_BYTES): void {
  checkLocation(location);
  const bytes = Buffer.from(JSON.stringify(value));
  let descriptor: number | undefined;
  try {
    if (bytes.length > maximum) unavailable();
    descriptor = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    if (!owned(fs.fstatSync(descriptor), false)) unavailable();
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    const named = fs.lstatSync(filename);
    if (!owned(named, false) || !sameFile(named, fs.fstatSync(descriptor))) unavailable();
    checkLocation(location);
  } finally {
    bytes.fill(0);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/** A read-only probe never creates a profile, identity, marker, or lock. */
export function readPairingIdentity(options: PairingIdentityOptions): PairingIdentityDescriptor | undefined {
  return withLocation(options, true, (location) => {
    if (inspect(`${location.stem}.lock`)) throw new PairingIdentityError("identity_locked");
    const record = readRecord(location);
    checkProfile(location);
    if (inspect(`${location.stem}.lock`)) throw new PairingIdentityError("identity_locked");
    return record ? descriptorOf(record) : undefined;
  });
}

/** Create once. Any interrupted/ambiguous write stays held for explicit recovery. */
export function beginPairingIdentity(options: PairingIdentityOptions): PairingIdentityDescriptor {
  return withLocation(options, false, (location) => withIdentityLock(location, (retainOnFailure) => {
    retainOnFailure(true);
    let record = readRecord(location);
    if (!record) {
      // Reserve this agent durably before generating any identity. A missing
      // key after this point must never be mistaken for a fresh agent.
      writeNew(location, `${location.stem}.initialized`, {
        schemaVersion: 1, localProfileId: options.localProfileId, agentId: options.agentId,
      });
      fs.fsyncSync(location.descriptor);
      const key = generateKeyPairSync("ed25519");
      const privateBytes = key.privateKey.export({ type: "pkcs8", format: "der" });
      try {
        const publicBytes = key.publicKey.export({ type: "spki", format: "der" });
        record = decodeRecord({ schemaVersion: 1, localProfileId: options.localProfileId, agentId: options.agentId,
          runnerPublicKey: publicBytes.subarray(PUBLIC_PREFIX.length).toString("base64"),
          localIntentNonce: randomBytes(32).toString("hex"), privateKey: privateBytes.toString("base64") }, options);
        const temporary = `${location.stem}.${randomUUID()}.tmp`;
        writeNew(location, temporary, record);
        checkLocation(location);
        if (inspect(`${location.stem}.json`)) unavailable();
        fs.renameSync(temporary, `${location.stem}.json`);
        // Keep the lock on failure, including a successful rename whose parent
        // fsync fails. Neither retries nor restart may rotate the key.
        fs.fsyncSync(location.descriptor);
      } finally { privateBytes.fill(0); }
    }
    return descriptorOf(record);
  }))!;
}

function withIdentityLock<T>(location: Location, action: (retainOnFailure: (retain: boolean) => void) => T): T {
  const lock = `${location.stem}.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error: unknown) {
    if (isRecord(error) && error.code === "EEXIST") throw new PairingIdentityError("identity_locked");
    throw error;
  }
  const lockIdentity = fs.lstatSync(lock);
  if (!owned(lockIdentity, true)) throw new PairingIdentityError("unsafe_path");
  checkLocation(location);
  fs.fsyncSync(location.descriptor);
  const release = (): void => {
    checkProfile(location);
    const current = fs.lstatSync(lock);
    if (!owned(current, true) || !sameFile(current, lockIdentity)) unavailable();
    fs.rmdirSync(lock);
    // Durable records precede release. A lock returning after a crash is
    // conservative recovery-required state, never an absent identity.
  };
  let held = false;
  try {
    const result = action((retain) => { held = retain; });
    release();
    return result;
  } catch (error: unknown) {
    // A rejected caller proposal cannot poison an untouched valid approval.
    // Ambiguous writes require recovery; later rejection of an already durable
    // approval (for example expiry during fsync) does not strand that approval.
    if (!held) { try { release(); } catch { /* A changed lock remains held. */ } }
    throw error;
  }
}

function requireRecord(location: Location): IdentityRecord { return readRecord(location) ?? unavailable(); }
/** A pairing wallet is never any local agent's trading wallet. Reads every trading envelope's
 * public address (never a key); a held, partial or unreadable record fails closed. */
function refuseTradingWallet(location: Location, wallet: { chain: "solana" | "base"; address: string }): void {
  if (wallet.chain !== "solana") return;
  let addresses: readonly { agentId: string; address: string }[];
  try { addresses = readTradingWalletAddresses(location.directory, location.options.localProfileId); }
  catch { return unavailable(); }
  if (addresses.some((entry) => entry.address === wallet.address)) throw new PairingIdentityError("trading_wallet");
}
function checkUnlocked(location: Location): void {
  if (inspect(`${location.stem}.lock`)) throw new PairingIdentityError("identity_locked");
}
function expectedIdentity(record: IdentityRecord, frontendOrigin: string) {
  return { frontendOrigin, runnerPublicKey: record.runnerPublicKey, localIntentNonce: record.localIntentNonce };
}
function readStage(location: Location, stage: Stage): unknown | undefined {
  const stem = `${location.stem}.${stage}`;
  const markerStat = inspect(`${stem}.initialized`);
  const stored = inspect(`${stem}.json`);
  if (!markerStat && !stored) return undefined;
  if (!markerStat || !stored) unavailable();
  const marker = readJson(location, `${stem}.initialized`);
  if (!isRecord(marker) || !exactKeys(marker, ["schemaVersion", "localProfileId", "agentId", "stage"])
    || marker.schemaVersion !== 1 || marker.localProfileId !== location.options.localProfileId
    || marker.agentId !== location.options.agentId || marker.stage !== stage) unavailable();
  return readJson(location, `${stem}.json`, MAX_BINDING_BYTES);
}
function readApprovalRecord(location: Location, record: IdentityRecord | undefined): ApprovalRecord | undefined {
  const value = readStage(location, "approval");
  if (value === undefined) return undefined;
  if (!record || !isRecord(value) || !exactKeys(value, ["schemaVersion", "frontendOrigin", "binding", "bindingDigest"])
    || value.schemaVersion !== 1 || typeof value.frontendOrigin !== "string" || !isRecord(value.binding)
    || typeof value.binding.challengeId !== "string") unavailable();
  const binding = validateRunnerPairingBinding(value.binding, {
    ...expectedIdentity(record, value.frontendOrigin), challengeId: value.binding.challengeId,
  });
  if (value.frontendOrigin !== new URL(value.frontendOrigin).origin || value.bindingDigest !== pairingBindingDigest(binding)) unavailable();
  return { schemaVersion: 1, frontendOrigin: value.frontendOrigin, binding, bindingDigest: value.bindingDigest as string };
}
function readAdoptionRecord(location: Location, record: IdentityRecord | undefined, approval: ApprovalRecord | undefined): AdoptionRecord | undefined {
  const value = readStage(location, "adoption");
  if (value === undefined) return undefined;
  if (!record || !approval || !isRecord(value) || !exactKeys(value, ["schemaVersion", "frontendOrigin", "receipt"])
    || value.schemaVersion !== 1 || value.frontendOrigin !== approval.frontendOrigin) unavailable();
  const receipt = validateRunnerPairingResponse(value.receipt, {
    ...expectedIdentity(record, approval.frontendOrigin), challengeId: approval.binding.challengeId,
    resource: "receipt", approvedBindingDigest: approval.bindingDigest,
  });
  if (receipt.resource !== "receipt") unavailable();
  return { schemaVersion: 1, frontendOrigin: approval.frontendOrigin, receipt };
}
function persistStage(location: Location, stage: Stage, value: ApprovalRecord | AdoptionRecord, replace = false): void {
  const stem = `${location.stem}.${stage}`;
  if (!replace) {
    writeNew(location, `${stem}.initialized`, { schemaVersion: 1,
      localProfileId: location.options.localProfileId, agentId: location.options.agentId, stage });
    fs.fsyncSync(location.descriptor);
  }
  const temporary = `${stem}.${randomUUID()}.tmp`;
  writeNew(location, temporary, value, MAX_BINDING_BYTES);
  checkLocation(location);
  const current = inspect(`${stem}.json`);
  if (replace ? !current || !owned(current, false) : current !== undefined) unavailable();
  fs.renameSync(temporary, `${stem}.json`);
  fs.fsyncSync(location.descriptor);
}
function adoptionOf(value: AdoptionRecord): PairingAdoption {
  return { frontendOrigin: value.frontendOrigin, agentId: value.receipt.agentId, pairedAt: value.receipt.pairedAt,
    pairing: "paired", execution: "unavailable" };
}
function signCheckedMessage(record: IdentityRecord, message: string): string {
  const bytes = Buffer.from(record.privateKey, "base64");
  try { return sign(null, Buffer.from(message, "utf8"), createPrivateKey({ key: bytes, type: "pkcs8", format: "der" })).toString("base64"); }
  finally { bytes.fill(0); }
}

/** Only the public SDK's fixed, expiring read purpose can reach this signer. */
export function signPairingReadProof(options: PairingIdentityOptions, input: { frontendOrigin: string; nonce: RunnerPairingReadNonce }): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["frontendOrigin", "nonce"]) || !isRecord(input.nonce)) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    const expected = { ...expectedIdentity(record, input.frontendOrigin), challengeId: input.nonce.challengeId, resource: input.nonce.resource };
    const message = runnerPairingReadMessage(input.nonce, expected);
    const frontendOrigin = new URL(input.frontendOrigin).origin;
    const replacementRead = approval && !adoption && input.nonce.resource === "challenge"
      && Date.parse(approval.binding.expiresAt) <= Date.now()
      && Date.parse(input.nonce.issuedAt) >= Date.parse(approval.binding.expiresAt);
    if ((input.nonce.resource === "receipt" && !approval)
      || (approval && (approval.frontendOrigin !== frontendOrigin
        || (approval.binding.challengeId !== input.nonce.challengeId && !replacementRead)))) unavailable();
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** The public SDK's intent-read nonce, without a separate package export. */
export type PairingIntentReadNonce = Parameters<typeof RunnerPairingClient.intentReadMessage>[0];

/**
 * Only the public SDK's fixed, expiring intent-read purpose reaches this signer. It is refused once a receipt is adopted,
 * and while an unexpired approval is pinned (that ceremony is finished through its own receipt read). After an approval
 * expires, only a read issued after its expiry may look for the replacement challenge.
 */
export function signPairingIntentReadProof(options: PairingIdentityOptions, input: { frontendOrigin: string; nonce: PairingIntentReadNonce }): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["frontendOrigin", "nonce"]) || !isRecord(input.nonce)) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    const message = RunnerPairingClient.intentReadMessage(input.nonce, expectedIdentity(record, input.frontendOrigin));
    const frontendOrigin = new URL(input.frontendOrigin).origin;
    if (adoption || (approval && (approval.frontendOrigin !== frontendOrigin
      || Date.parse(approval.binding.expiresAt) > Date.now()
      || Date.parse(input.nonce.issuedAt) < Date.parse(approval.binding.expiresAt)))) unavailable();
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** Public approval metadata only; no challenge message or signature is stored. */
export function readPairingApproval(options: PairingIdentityOptions): PairingApproval | undefined {
  return withLocation(options, true, (location) => {
    checkUnlocked(location);
    const record = readRecord(location);
    const approval = readApprovalRecord(location, record);
    readAdoptionRecord(location, record, approval);
    checkProfile(location);
    checkUnlocked(location);
    return approval ? { frontendOrigin: approval.frontendOrigin, challengeId: approval.binding.challengeId,
      bindingDigest: approval.bindingDigest, expiresAt: approval.binding.expiresAt } : undefined;
  });
}

/** The caller supplies deliberate approval; the binding is independently checked and durably pinned before signing. */
export function approvePairingIdentity(options: PairingIdentityOptions, input: {
  frontendOrigin: string; challenge: RunnerPairingChallenge; approvedBindingDigest: string;
}): { version: 1; challengeId: string; bindingDigest: string; runnerSignature: string } {
  return withLocation(options, false, (location) => withIdentityLock(location, (retainOnFailure) => {
    if (!isRecord(input) || !exactKeys(input, ["frontendOrigin", "challenge", "approvedBindingDigest"]) || !isRecord(input.challenge)) unavailable();
    const record = requireRecord(location);
    const expected = { ...expectedIdentity(record, input.frontendOrigin), challengeId: input.challenge.challengeId, resource: "challenge" as const };
    const challenge = validateRunnerPairingResponse(input.challenge, expected);
    if (challenge.resource !== "challenge" || input.approvedBindingDigest !== challenge.bindingDigest) unavailable();
    const wallet = { chain: challenge.binding.walletChain, address: challenge.binding.walletAddress };
    // Before pinning: an agent's trading key is never accepted as the owner's pairing wallet.
    refuseTradingWallet(location, wallet);
    const frontendOrigin = new URL(input.frontendOrigin).origin;
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (adoption) unavailable();
    if (approval && (approval.bindingDigest !== challenge.bindingDigest || approval.frontendOrigin !== frontendOrigin)) {
      const previous = approval.binding;
      const next = challenge.binding;
      // The service issues a replacement only after atomically fencing the old
      // expired ceremony against confirmation. Require the same owner/wallet
      // and a fresh explicit approval; never silently transfer an identity.
      if (approval.frontendOrigin !== frontendOrigin || previous.challengeId === next.challengeId
        || Date.parse(previous.expiresAt) > Date.now() || Date.parse(next.issuedAt) < Date.parse(previous.expiresAt)
        || previous.ownerUserId !== next.ownerUserId || previous.walletAccountId !== next.walletAccountId
        || previous.walletChain !== next.walletChain || previous.walletAddress !== next.walletAddress
        || previous.chainId !== next.chainId) unavailable();
    }
    if (!approval || approval.bindingDigest !== challenge.bindingDigest) {
      retainOnFailure(true);
      persistStage(location, "approval", { schemaVersion: 1, frontendOrigin,
        binding: challenge.binding, bindingDigest: challenge.bindingDigest }, approval !== undefined);
      retainOnFailure(false);
    }
    // A slow disk must not turn an expired challenge into an accepted signature.
    validateRunnerPairingResponse(challenge, expected);
    // Re-read after pinning: the daemon refuses this pinned wallet from here on, and a
    // trading record installed meanwhile still blocks the signature.
    refuseTradingWallet(location, wallet);
    return { version: 1, challengeId: challenge.challengeId, bindingDigest: challenge.bindingDigest,
      runnerSignature: signCheckedMessage(record, challenge.message) };
  }))!;
}

/** Adopt only the receipt for a locally persisted deliberate approval, never a supplied digest. */
export function adoptPairingIdentity(options: PairingIdentityOptions, input: { frontendOrigin: string; receipt: RunnerPairingReceipt }): PairingAdoption {
  return withLocation(options, false, (location) => withIdentityLock(location, (retainOnFailure) => {
    if (!isRecord(input) || !exactKeys(input, ["frontendOrigin", "receipt"])) unavailable();
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    if (!approval || new URL(input.frontendOrigin).origin !== approval.frontendOrigin) unavailable();
    const receipt = validateRunnerPairingResponse(input.receipt, { ...expectedIdentity(record, input.frontendOrigin),
      challengeId: approval.binding.challengeId, resource: "receipt", approvedBindingDigest: approval.bindingDigest });
    if (receipt.resource !== "receipt") unavailable();
    const current = readAdoptionRecord(location, record, approval);
    if (current) {
      if (current.receipt.pairedAt !== receipt.pairedAt || current.receipt.bindingDigest !== receipt.bindingDigest) unavailable();
      return adoptionOf(current);
    }
    const next: AdoptionRecord = { schemaVersion: 1, frontendOrigin: approval.frontendOrigin, receipt };
    retainOnFailure(true);
    persistStage(location, "adoption", next);
    retainOnFailure(false);
    return adoptionOf(next);
  }))!;
}

export function readPairingAdoption(options: PairingIdentityOptions): PairingAdoption | undefined {
  return withLocation(options, true, (location) => {
    checkUnlocked(location);
    const record = readRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    checkProfile(location);
    checkUnlocked(location);
    return adoption ? adoptionOf(adoption) : undefined;
  });
}

/** Reads the trusted destination and identity without initializing or exporting keys. */
export function readPairedRunnerDescriptor(options: PairingIdentityOptions): PairedRunnerDescriptor | undefined {
  return withLocation(options, true, (location) => {
    checkUnlocked(location);
    const record = readRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    checkProfile(location);
    checkUnlocked(location);
    return adoption ? { frontendOrigin: adoption.frontendOrigin, agentId: adoption.receipt.agentId,
      bindingDigest: adoption.receipt.bindingDigest, runnerPublicKey: adoption.receipt.binding.runnerPublicKey } : undefined;
  });
}

/** Read-only early refusal before an approval prompt; `approvePairingIdentity` re-checks under its lock. */
export function checkPairingWalletSeparation(options: PairingIdentityOptions, wallet: { chain: "solana" | "base"; address: string }): void {
  withLocation(options, false, (location) => {
    if (!isRecord(wallet) || (wallet.chain !== "solana" && wallet.chain !== "base") || typeof wallet.address !== "string") unavailable();
    refuseTradingWallet(location, wallet);
  });
}

/** The owner's public wallet from the locally pinned approval (an adoption implies it).
 * Used only to refuse that wallet as a local trading key; never a key or a proof. */
export function readPairingWallet(options: PairingIdentityOptions): { chain: "solana" | "base"; address: string } | undefined {
  return withLocation(options, true, (location) => {
    checkUnlocked(location);
    const record = readRecord(location);
    const approval = readApprovalRecord(location, record);
    readAdoptionRecord(location, record, approval);
    checkProfile(location);
    checkUnlocked(location);
    return approval ? { chain: approval.binding.walletChain, address: approval.binding.walletAddress } : undefined;
  });
}

/** M3.2 S6 moment 3: the owner-approval identity of the durably ADOPTED agent, from the locally pinned pairing record only:
 * Balchemy's agent id, binding digest, runner key and frontend origin, plus the owner's paired wallet and the chain id the owner
 * signed at pairing. The runner re-derives a first_enable message from these (never from a backend-supplied value). Public facts
 * only; never a key or a proof. Undefined until the pairing is adopted. */
export interface PairingOwnerApprovalIdentity extends PairedRunnerDescriptor {
  pairedWallet: { chain: "solana" | "base"; address: string };
  chainId: string;
}
export function readPairingOwnerApprovalIdentity(options: PairingIdentityOptions): PairingOwnerApprovalIdentity | undefined {
  return withLocation(options, true, (location) => {
    checkUnlocked(location);
    const record = readRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    checkProfile(location);
    checkUnlocked(location);
    if (!adoption || !approval) return undefined;
    return { frontendOrigin: adoption.frontendOrigin, agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: adoption.receipt.binding.runnerPublicKey,
      pairedWallet: { chain: approval.binding.walletChain, address: approval.binding.walletAddress }, chainId: approval.binding.chainId };
  });
}

/** Only a signed, non-executing status purpose for the durably adopted agent. */
export function signRunnerRuntimeProof(options: PairingIdentityOptions, input: {
  instanceId: string; operation: RunnerRuntimeActionBody; nonce: RunnerRuntimeNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "operation", "nonce"])
      || !isRecord(input.operation) || !exactKeys(input.operation, ["action", "body"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerRuntimeNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, ...input.operation });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** The identity key signs only the adopted agent's bounded control protocol. */
export function signRunnerControlProof(options: PairingIdentityOptions, input: {
  instanceId: string; operation: RunnerControlOperation; nonce: RunnerControlNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "operation", "nonce"])
      || !isRecord(input.operation)
      || !exactKeys(input.operation, input.operation.action === "ack" ? ["action", "command", "body"] : ["action", "body"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerControlNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, ...input.operation });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** Signs only typed public research for this adopted identity, never an arbitrary prompt or transaction. */
export function signRunnerResearchProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerResearchRequest; nonce: RunnerResearchNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerResearchNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** Signs only the fixed read-only assessment purpose for one exact plan request of this adopted
 * identity, instance and epoch. The SDK message builder re-validates the nonce; never a transaction. */
export function signRunnerAssessmentProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerAssessmentRequest; nonce: RunnerAssessmentNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerAssessmentNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** Signs only a poll or durable-receipt ACK for the adopted signal inbox. */
export function signRunnerSignalsProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerSignalsRequest; nonce: RunnerSignalsNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerSignalsNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** Signs only the fixed-purpose RPC access nonce (owner decision of 17 Nov 2026: Balchemy-provided Solana RPC) for the adopted
 * agent and this instance's live lease epoch. It authorizes nothing beyond receiving the two provider credentials. */
export function signRunnerRpcAccessProof(options: PairingIdentityOptions, input: { instanceId: string; epoch: number; nonce: RunnerRpcAccessNonce }): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerRpcAccessNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** Signs only one bounded decision report (fixed purpose, exact report digest) for the adopted agent; never free text. */
export function signRunnerDecisionReportProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; report: RunnerDecisionReport; nonce: RunnerDecisionReportNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "report", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerDecisionReportNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, report: input.report });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** The adopted approval's pairing wallet is never a trading wallet, in a bind or a build request. */
function refusePairingWalletRequest(approval: ApprovalRecord | undefined, request: unknown): void {
  const address = isRecord(request) ? Object.getOwnPropertyDescriptor(request, "walletAddress") : undefined;
  if (!approval || !address || !("value" in address) || typeof address.value !== "string") unavailable();
  if (approval.binding.walletChain === "solana" && approval.binding.walletAddress === address.value) throw new PairingIdentityError("trading_wallet");
}

/** Signs only the fixed trading-wallet bind nonce for this adopted identity, instance and epoch. The SDK message builder
 * re-validates the nonce, target and closed request; never a transaction or the trading key's possession message. */
export function signRunnerTradingWalletProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerTradingWalletRequest; nonce: RunnerTradingWalletNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    refusePairingWalletRequest(approval, input.request);
    const message = runnerTradingWalletNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** Signs only the fixed keyless execution-build nonce for one exact closed request of this adopted identity. A build
 * returns unsigned bytes; this never signs a transaction and grants no execution authority by itself. */
export function signRunnerExecutionProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerExecutionBuyRequest; nonce: RunnerExecutionNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    // S5c: own data field only (never an accessor): exactly the buy direction. An exit has its own signer below.
    const direction = isRecord(input.request) ? Object.getOwnPropertyDescriptor(input.request, "direction") : undefined;
    if (!direction || !("value" in direction) || direction.value !== "buy") unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    refusePairingWalletRequest(approval, input.request);
    const message = runnerExecutionNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** S5c: signs only the fixed keyless execution-build nonce (the same purpose and route as a buy) for one exact closed EXIT
 * (sell) request of this adopted identity, instance and epoch. Anything but an exit intent is refused before any key is
 * read, and the pairing wallet is refused as the selling wallet exactly as for a buy. The SDK message builder re-validates
 * the nonce and the closed exit request. A build returns unsigned bytes; this never signs a transaction and grants no
 * execution authority by itself. `signRunnerExecutionProof` stays the buy signer. */
export function signRunnerExitExecutionProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerExitRequest; nonce: RunnerExecutionNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    // Own data field only (never an accessor): exactly the exit direction.
    const direction = isRecord(input.request) ? Object.getOwnPropertyDescriptor(input.request, "direction") : undefined;
    if (!direction || !("value" in direction) || direction.value !== "sell") unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    refusePairingWalletRequest(approval, input.request);
    const message = runnerExecutionNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** S5c: signs only the fixed read-only sell-assessment purpose for one exact sell request (position mint -> WSOL) of this
 * adopted identity, instance and epoch. The SDK message builder re-validates the nonce; never a transaction, never a build. */
export function signRunnerSellAssessmentProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerSellAssessmentRequest; nonce: RunnerSellAssessmentNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const message = runnerSellAssessmentNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin,
      agentId: adoption.receipt.agentId, bindingDigest: adoption.receipt.bindingDigest,
      runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch, request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}

/** One adopted-identity signature over exactly the SDK-derived message for this agent, instance and epoch. */
function signAdoptedRelayProof(options: PairingIdentityOptions, input: unknown,
  message: (target: { frontendOrigin: string; agentId: string; bindingDigest: string; runnerPublicKey: string }) => string): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption) unavailable();
    const derived = message({ frontendOrigin: adoption.frontendOrigin, agentId: adoption.receipt.agentId,
      bindingDigest: adoption.receipt.bindingDigest, runnerPublicKey: record.runnerPublicKey });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, derived);
  })!;
}

/** Signs only the fixed relay-submit nonce for one exact stored attempt (its already-signed wire bytes and attempt key) of
 * this adopted identity, instance and epoch. It authorizes relaying bytes the trading key signed; it never signs a transaction. */
export function signRunnerExecutionSubmitProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerExecutionSubmitRequest; nonce: RunnerExecutionSubmitNonce;
}): string {
  return signAdoptedRelayProof(options, input, (target) => runnerExecutionSubmitNonceMessage(input.nonce,
    { ...target, instanceId: input.instanceId, epoch: input.epoch, request: input.request }));
}

/** Signs only the fixed read-only relay-status nonce for one reservation/build digest of this adopted identity. */
export function signRunnerExecutionStatusProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerExecutionStatusRequest; nonce: RunnerExecutionStatusNonce;
}): string {
  return signAdoptedRelayProof(options, input, (target) => runnerExecutionStatusNonceMessage(input.nonce,
    { ...target, instanceId: input.instanceId, epoch: input.epoch, request: input.request }));
}

/** K4: signs only the fixed launchpad-subscriptions query nonce (a `get`, or a `set` of exactly these sorted launchpad ids) of this
 * adopted identity, instance and epoch. It chooses which public launch observations Balchemy delivers; it never authorizes a trade
 * and never signs a transaction. */
export function signRunnerLaunchpadSubscriptionsProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerLaunchpadSubscriptionsRequest; nonce: RunnerLaunchpadSubscriptionsNonce;
}): string {
  return signAdoptedRelayProof(options, input, (target) => runnerLaunchpadSubscriptionsNonceMessage(input.nonce,
    { ...target, instanceId: input.instanceId, epoch: input.epoch, request: input.request }));
}

/** M3.2 S6 moment 3: signs only the fixed first_enable create nonce for one exact request (this profile's active trading-wallet
 * binding and current caps) of this adopted identity, instance and epoch. It asks Balchemy to open an owner-approval challenge;
 * it never approves anything (only the owner's paired wallet can) and never signs a transaction. */
export function signRunnerFirstEnableProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerFirstEnableRequest; nonce: RunnerFirstEnableNonce;
}): string {
  return signAdoptedRelayProof(options, input, (target) => runnerFirstEnableNonceMessage(input.nonce,
    { ...target, instanceId: input.instanceId, epoch: input.epoch, request: input.request }));
}

/** M3.2 S6 moment 3: signs only the fixed read-only first_enable read nonce (one challenge, or the latest approval for one
 * trading-wallet binding) of this adopted identity, instance and epoch. */
export function signRunnerFirstEnableReadProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerFirstEnableReadRequest; nonce: RunnerFirstEnableReadNonce;
}): string {
  return signAdoptedRelayProof(options, input, (target) => runnerFirstEnableReadNonceMessage(input.nonce,
    { ...target, instanceId: input.instanceId, epoch: input.epoch, request: input.request }));
}

/** K2 one-visit setup: signs only the fixed read-only spend-ceiling PROPOSAL read nonce (one trading-wallet binding) of this adopted
 * identity, instance and epoch. The SDK message builder re-validates the nonce against the target derived here from the adopted
 * record (never from the caller's copy), and the pairing wallet is refused as the named trading wallet. A proposal grants nothing:
 * this never opens, approves or signs anything else. */
export function signRunnerCeilingReadProof(options: PairingIdentityOptions, input: {
  instanceId: string; epoch: number; request: RunnerCeilingReadRequest; nonce: RunnerCeilingReadNonce;
}): string {
  return withLocation(options, false, (location) => {
    if (!isRecord(input) || !exactKeys(input, ["instanceId", "epoch", "request", "nonce"])) unavailable();
    checkUnlocked(location);
    const record = requireRecord(location);
    const approval = readApprovalRecord(location, record);
    const adoption = readAdoptionRecord(location, record, approval);
    if (!adoption || !approval) unavailable();
    const named = isRecord(input.request) ? Object.getOwnPropertyDescriptor(input.request, "tradingWalletAddress") : undefined;
    if (!named || !("value" in named) || typeof named.value !== "string") unavailable();
    if (approval.binding.walletChain === "solana" && approval.binding.walletAddress === named.value) throw new PairingIdentityError("trading_wallet");
    const message = runnerCeilingReadNonceMessage(input.nonce, { frontendOrigin: adoption.frontendOrigin, agentId: adoption.receipt.agentId,
      bindingDigest: adoption.receipt.bindingDigest, runnerPublicKey: record.runnerPublicKey, instanceId: input.instanceId, epoch: input.epoch,
      request: input.request });
    checkProfile(location);
    checkUnlocked(location);
    return signCheckedMessage(record, message);
  })!;
}
