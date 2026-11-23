/** Optional, daemon-owned encrypted model credentials. Never imports legacy keys.
 * The passphrase and derived key live only for one operation; restarting requires
 * explicit unlock. This cannot protect an already-unlocked process from its OS owner.
 * Phase 2 (owner decision of 19 Nov 2026, one passphrase for the model key and the trading wallet): the passphrase is
 * NFC-normalized before the key derivation, exactly as the trading wallet does. A record sealed earlier from a passphrase that is
 * not NFC-stable still opens: its raw UTF-8 form is tried once after the NFC form fails, and the next save re-seals it in NFC. */
import * as fs from "node:fs";
import * as path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scrypt } from "node:crypto";
import { privateOwned, sameIdentity } from "./kernel-lock.js";
import { exactKeys, isId, isRecord } from "./protocol.js";
import type { PrivateBrainModelConfig } from "./private-brain-models.js";
import { isPrivateModelPassphrase } from "./private-brain-protocol.js";
import { isPrivateBrainModelId, isPrivateBrainProvider, type PrivateBrainProvider } from "./private-brain-providers.js";
import { addRunnerAgent } from "./agent-roster.js";

export const PRIVATE_MODEL_VAULT_FILE = "private-model-vault.json";
export const PRIVATE_MODEL_VAULT_MARKER = "private-model-vault.initialized";
const SUITE = "scrypt-n131072-r8-p1-aes256gcm-v1";
const MAX_FILE_BYTES = 1024 * 1024;
export type PrivateModelVaultErrorCode = "invalid_request" | "unknown_agent" | "revision_conflict"
  | "vault_locked" | "vault_missing" | "busy" | "cancelled" | "state_unavailable" | "closing";
export class PrivateModelVaultError extends Error {
  constructor(readonly code: PrivateModelVaultErrorCode) { super(`Local model vault ${code}`); this.name = "PrivateModelVaultError"; }
}
export type PrivateModelVaultState = { saved: false; revision: 0 }
  | { saved: true; revision: number; provider: PrivateBrainProvider; model: string };
interface Envelope {
  agentId: string; revision: number; provider: PrivateBrainProvider; model: string;
  suite: typeof SUITE; salt: string; nonce: string; ciphertext: string; tag: string;
}
interface Snapshot { schemaVersion: 1; localProfileId: string; entries: Envelope[] }
export interface PrivateModelVaultOptions {
  directory: string; localProfileId: string; agentIds: readonly string[];
  /** Existing daemon writer capability; this vault never creates a second lock. */
  assertAvailable(): void;
}
function fail(code: PrivateModelVaultErrorCode): never { throw new PrivateModelVaultError(code); }
function sameContents(a: fs.Stats, b: fs.Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function exists(filename: string): fs.Stats | undefined {
  try { return fs.lstatSync(filename); }
  catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return undefined; throw error; }
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export const isModelVaultPassphrase = isPrivateModelPassphrase;
function config(value: unknown): PrivateBrainModelConfig {
  if (!isRecord(value) || !exactKeys(value, ["provider", "model", "apiKey"])
    || !isPrivateBrainProvider(value.provider) || !isPrivateBrainModelId(value.model)
    || typeof value.apiKey !== "string" || !/^[!-~]{1,4096}$/.test(value.apiKey)) fail("invalid_request");
  return { provider: value.provider, model: value.model, apiKey: value.apiKey };
}
function base64(value: unknown, maximum: number, exact?: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(maximum / 3) * 4
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const bytes = Buffer.from(value, "base64");
  return bytes.length <= maximum && (exact === undefined || bytes.length === exact) && bytes.toString("base64") === value;
}
function aad(localProfileId: string, entry: Envelope): Buffer {
  // The provider name selects one fixed endpoint (private-brain-providers.ts); this AAD binds that name and the model.
  return Buffer.from(JSON.stringify(["balchemy.private-model.v1", localProfileId, entry.agentId,
    entry.revision, entry.provider, entry.model, entry.suite, entry.salt, entry.nonce]), "utf8");
}
/** The forms of a passphrase to derive with, in order: NFC first, then (only when it differs) the raw form older records used. */
export function modelVaultPassphraseForms(passphrase: string): string[] {
  const normalized = passphrase.normalize("NFC");
  return normalized === passphrase ? [normalized] : [normalized, passphrase];
}
async function derive(passphrase: string, salt: string): Promise<Buffer> {
  const password = Buffer.from(passphrase, "utf8");
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(salt, "base64"), 32,
        { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 },
        (error, key) => error ? reject(new PrivateModelVaultError("state_unavailable")) : resolve(key));
    });
  } finally { password.fill(0); }
}

export class PrivateModelVault {
  private readonly options: PrivateModelVaultOptions;
  private readonly agentList: string[];
  private readonly directory: string;
  private readonly directoryFd: number;
  private readonly directoryIdentity: fs.Stats;
  private snapshot: Snapshot;
  private snapshotIdentity?: fs.Stats;
  private markerIdentity?: fs.Stats;
  private held = false;
  private closed = false;
  private active = false;

  constructor(options: PrivateModelVaultOptions) {
    if (!isId(options.localProfileId) || !Array.isArray(options.agentIds) || options.agentIds.length < 1
      || options.agentIds.length > 64 || options.agentIds.some((id) => !isId(id))
      || new Set(options.agentIds).size !== options.agentIds.length || typeof options.assertAvailable !== "function"
      || typeof options.directory !== "string" || !path.isAbsolute(options.directory)) fail("invalid_request");
    this.agentList = [...options.agentIds]; this.options = { ...options, agentIds: this.agentList };
    this.directory = path.resolve(options.directory);
    this.snapshot = { schemaVersion: 1, localProfileId: options.localProfileId, entries: [] };
    let fd: number | undefined;
    try {
      options.assertAvailable();
      this.ancestors();
      const named = fs.lstatSync(this.directory);
      fd = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!privateOwned(named, "directory") || !privateOwned(opened, "directory") || !sameIdentity(named, opened)) fail("state_unavailable");
      this.directoryFd = fd; this.directoryIdentity = opened;
      const marker = exists(this.filename(PRIVATE_MODEL_VAULT_MARKER));
      const saved = exists(this.filename(PRIVATE_MODEL_VAULT_FILE));
      if (!!marker !== !!saved) fail("state_unavailable");
      if (marker && saved) {
        const readMarker = this.readFile(PRIVATE_MODEL_VAULT_MARKER, 1024);
        const value = readMarker.value;
        if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId"])
          || value.schemaVersion !== 1 || value.localProfileId !== options.localProfileId) fail("state_unavailable");
        this.markerIdentity = readMarker.identity;
        const readSnapshot = this.readFile(PRIVATE_MODEL_VAULT_FILE, MAX_FILE_BYTES);
        this.snapshot = this.decode(readSnapshot.value); this.snapshotIdentity = readSnapshot.identity;
      }
      this.available();
      // A model status read on a new profile must not create a credential file.
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      fail("state_unavailable");
    }
  }
  /** Owner decision of 19 Nov 2026 (agent-roster.ts): an agent added to the running daemon. Only extends this instance's agent list;
   * nothing of another agent is read, rebuilt or reset. Idempotent; throws (changing nothing) on an invalid id or past 64 agents. */
  addAgent(agentId: string): void { addRunnerAgent(this.agentList, agentId); }

  state(agentId: string): PrivateModelVaultState {
    this.available(); this.agent(agentId);
    const entry = this.snapshot.entries.find((item) => item.agentId === agentId);
    return entry ? { saved: true, revision: entry.revision, provider: entry.provider, model: entry.model }
      : { saved: false, revision: 0 };
  }

  /** Replacing a saved model requires its current passphrase. A forgotten or
   * incorrect passphrase never resets/overwrites the only saved credential. */
  async save(agentId: string, expectedRevision: number, input: PrivateBrainModelConfig, passphrase: string,
    signal?: AbortSignal, guard: () => void = () => {}): Promise<PrivateModelVaultState> {
    const selected = config(input); // Pin caller values before the first await.
    if (expectedRevision === Number.MAX_SAFE_INTEGER) fail("revision_conflict");
    const previous = this.begin(agentId, expectedRevision, passphrase, signal);
    let key: Buffer | undefined;
    try {
      const salt = previous?.salt ?? randomBytes(32).toString("base64");
      if (previous) key = await this.nfcKey(agentId, expectedRevision, previous, passphrase, signal, guard);
      else { key = await derive(passphrase.normalize("NFC"), salt); this.checkOperation(agentId, expectedRevision, signal); guard(); }
      return this.seal(agentId, expectedRevision, selected, salt, key, signal, guard);
    } finally { key?.fill(0); this.active = false; }
  }

  /** Phase 2 `model_reselect`: the saved key with another model of the same provider, without the key being entered again. The
   * current passphrase must open the saved record; the key never leaves the daemon. Same salt, a new nonce, revision + 1. */
  async reselect(agentId: string, expectedRevision: number, model: string, passphrase: string,
    signal?: AbortSignal, guard: () => void = () => {}): Promise<PrivateBrainModelConfig> {
    if (!isPrivateBrainModelId(model)) fail("invalid_request");
    if (expectedRevision === Number.MAX_SAFE_INTEGER) fail("revision_conflict");
    const previous = this.begin(agentId, expectedRevision, passphrase, signal);
    let key: Buffer | undefined;
    try {
      if (!previous) fail("vault_missing");
      const opened = await this.open(agentId, expectedRevision, previous, passphrase, signal, guard);
      const selected = config({ provider: opened.selected.provider, model, apiKey: opened.selected.apiKey });
      key = opened.key;
      if (!opened.normalized) { key.fill(0); key = await derive(passphrase.normalize("NFC"), previous.salt); this.checkOperation(agentId, expectedRevision, signal); guard(); }
      this.seal(agentId, expectedRevision, selected, previous.salt, key, signal, guard);
      return selected;
    } finally { key?.fill(0); this.active = false; }
  }

  /** Derives with each passphrase form until one decrypts the record (vault_locked when none does). The returned key is the caller's to clear. */
  private async open(agentId: string, expectedRevision: number, entry: Envelope, passphrase: string, signal: AbortSignal | undefined,
    guard: () => void): Promise<{ key: Buffer; selected: PrivateBrainModelConfig; normalized: boolean }> {
    const forms = modelVaultPassphraseForms(passphrase);
    for (const [index, form] of forms.entries()) {
      const key = await derive(form, entry.salt);
      try { this.checkOperation(agentId, expectedRevision, signal); guard(); }
      catch (error: unknown) { key.fill(0); throw error; }
      try { return { key, selected: this.decrypt(entry, key), normalized: index === 0 }; }
      catch (error: unknown) { key.fill(0); if (!(error instanceof PrivateModelVaultError) || error.code !== "vault_locked") throw error; }
    }
    return fail("vault_locked");
  }
  /** The NFC-derived key for re-sealing a record the passphrase opens (a legacy raw-form record is re-derived once in NFC). */
  private async nfcKey(agentId: string, expectedRevision: number, entry: Envelope, passphrase: string, signal: AbortSignal | undefined,
    guard: () => void): Promise<Buffer> {
    const opened = await this.open(agentId, expectedRevision, entry, passphrase, signal, guard);
    if (opened.normalized) return opened.key;
    opened.key.fill(0);
    const key = await derive(passphrase.normalize("NFC"), entry.salt);
    try { this.checkOperation(agentId, expectedRevision, signal); guard(); } catch (error: unknown) { key.fill(0); throw error; }
    return key;
  }

  private seal(agentId: string, expectedRevision: number, selected: PrivateBrainModelConfig, salt: string, key: Buffer,
    signal: AbortSignal | undefined, guard: () => void): PrivateModelVaultState {
    const entry: Envelope = { agentId, revision: expectedRevision + 1, provider: selected.provider, model: selected.model,
      suite: SUITE, salt, nonce: randomBytes(12).toString("base64"), ciphertext: "", tag: "" };
    const plaintext = Buffer.from(JSON.stringify(selected), "utf8");
    try {
      const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(entry.nonce, "base64"), { authTagLength: 16 });
      cipher.setAAD(aad(this.options.localProfileId, entry));
      entry.ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]).toString("base64");
      entry.tag = cipher.getAuthTag().toString("base64");
    } finally { plaintext.fill(0); }
    this.checkOperation(agentId, expectedRevision, signal); guard();
    const next: Snapshot = { ...this.snapshot, entries: [...this.snapshot.entries.filter((item) => item.agentId !== agentId), entry] };
    this.commit(next);
    return this.state(agentId);
  }

  /** Returns a copy only to the daemon's in-memory model selector. Never IPC. */
  async unlock(agentId: string, expectedRevision: number, passphrase: string,
    signal?: AbortSignal, guard: () => void = () => {}): Promise<PrivateBrainModelConfig> {
    const previous = this.begin(agentId, expectedRevision, passphrase, signal);
    let key: Buffer | undefined;
    try {
      if (!previous) fail("vault_missing");
      const opened = await this.open(agentId, expectedRevision, previous, passphrase, signal, guard);
      key = opened.key;
      this.checkOperation(agentId, expectedRevision, signal); guard();
      return opened.selected;
    } finally { key?.fill(0); this.active = false; }
  }

  close(): void { if (!this.closed) { this.closed = true; fs.closeSync(this.directoryFd); } }

  private begin(agentId: string, expectedRevision: number, passphrase: string, signal?: AbortSignal): Envelope | undefined {
    this.checkOperation(agentId, expectedRevision, signal);
    if (!isModelVaultPassphrase(passphrase)) fail("invalid_request");
    if (this.active) fail("busy");
    this.active = true;
    return this.snapshot.entries.find((item) => item.agentId === agentId);
  }
  private checkOperation(agentId: string, expected: number, signal?: AbortSignal): void {
    const state = this.state(agentId);
    if (!revision(expected) || state.revision !== expected) fail("revision_conflict");
    if (signal?.aborted) fail("cancelled");
  }
  private decrypt(entry: Envelope, key: Buffer): PrivateBrainModelConfig {
    let part: Buffer | undefined; let final: Buffer | undefined; let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.nonce, "base64"), { authTagLength: 16 });
      decipher.setAAD(aad(this.options.localProfileId, entry)); decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      part = decipher.update(Buffer.from(entry.ciphertext, "base64")); final = decipher.final();
      plaintext = Buffer.concat([part, final]);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
      const value: unknown = JSON.parse(text);
      const selected = config(value);
      if (JSON.stringify(selected) !== text || selected.provider !== entry.provider || selected.model !== entry.model) fail("vault_locked");
      return selected;
    } catch { throw new PrivateModelVaultError("vault_locked"); }
    finally { part?.fill(0); final?.fill(0); plaintext?.fill(0); }
  }
  private decode(value: unknown): Snapshot {
    if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "entries"])
      || value.schemaVersion !== 1 || value.localProfileId !== this.options.localProfileId
      || !Array.isArray(value.entries) || value.entries.length > this.options.agentIds.length) fail("state_unavailable");
    const seen = new Set<string>();
    const entries = value.entries.map((item): Envelope => {
      if (!isRecord(item) || !exactKeys(item, ["agentId", "revision", "provider", "model", "suite", "salt", "nonce", "ciphertext", "tag"])
        || !isId(item.agentId) || !this.options.agentIds.includes(item.agentId) || seen.has(item.agentId)
        || !revision(item.revision) || item.revision < 1 || !isPrivateBrainProvider(item.provider)
        || !isPrivateBrainModelId(item.model) || item.suite !== SUITE
        || !base64(item.salt, 32, 32) || !base64(item.nonce, 12, 12) || !base64(item.tag, 16, 16)
        || !base64(item.ciphertext, 16 * 1024)) fail("state_unavailable");
      seen.add(item.agentId);
      return item as unknown as Envelope;
    });
    return { schemaVersion: 1, localProfileId: this.options.localProfileId, entries };
  }
  private agent(agentId: string): void { if (!isId(agentId) || !this.options.agentIds.includes(agentId)) fail("unknown_agent"); }
  private filename(name: string): string { return path.join(this.directory, name); }
  private ancestors(): void {
    let current = path.parse(this.directory).root;
    for (const segment of this.directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("state_unavailable");
    }
  }
  private location(): void {
    this.options.assertAvailable(); this.ancestors();
    const named = fs.lstatSync(this.directory); const opened = fs.fstatSync(this.directoryFd);
    if (!privateOwned(named, "directory") || !privateOwned(opened, "directory")
      || !sameIdentity(named, this.directoryIdentity) || !sameIdentity(opened, this.directoryIdentity)) fail("state_unavailable");
  }
  private available(): void {
    if (this.closed) fail("closing");
    if (this.held) fail("state_unavailable");
    try {
      this.location();
      for (const [name, identity] of [[PRIVATE_MODEL_VAULT_MARKER, this.markerIdentity], [PRIVATE_MODEL_VAULT_FILE, this.snapshotIdentity]] as const) {
        const named = exists(this.filename(name));
        if (identity ? !named || !privateOwned(named, "file") || !sameContents(named, identity) : !!named) fail("state_unavailable");
      }
    } catch { this.held = true; fail("state_unavailable"); }
  }
  private readFile(name: string, maximum: number): { value: unknown; identity: fs.Stats } {
    this.location();
    const filename = this.filename(name); const named = fs.lstatSync(filename);
    if (!privateOwned(named, "file") || named.size < 1 || named.size > maximum) fail("state_unavailable");
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const bytes = Buffer.alloc(maximum + 1);
    try {
      const opened = fs.fstatSync(fd);
      if (!privateOwned(opened, "file") || !sameContents(named, opened)) fail("state_unavailable");
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count;
      }
      if (length !== opened.size || length > maximum || !sameContents(opened, fs.fstatSync(fd))
        || !sameContents(opened, fs.lstatSync(filename))) fail("state_unavailable");
      this.location();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      const value: unknown = JSON.parse(text);
      if (JSON.stringify(value) !== text) fail("state_unavailable");
      return { value, identity: opened };
    } finally { bytes.fill(0); fs.closeSync(fd); }
  }
  private writeMarker(): void {
    this.available();
    const filename = this.filename(PRIVATE_MODEL_VAULT_MARKER);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ schemaVersion: 1, localProfileId: this.options.localProfileId })); fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
      if (!privateOwned(opened, "file") || !privateOwned(named, "file") || !sameContents(opened, named)) fail("state_unavailable");
      this.location(); fs.fsyncSync(this.directoryFd); this.markerIdentity = named;
    } finally { fs.closeSync(fd); }
  }
  private commit(next: Snapshot): void {
    const bytes = Buffer.from(JSON.stringify(next), "utf8");
    if (bytes.length > MAX_FILE_BYTES) fail("state_unavailable");
    let fd: number | undefined; let identity: fs.Stats | undefined;
    const temporary = this.filename(`.private-model-${randomUUID()}.tmp`);
    try {
      this.available();
      // An interrupted first save is held, never silently reinitialized.
      if (!this.markerIdentity) this.writeMarker();
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      identity = fs.fstatSync(fd); if (!privateOwned(identity, "file")) fail("state_unavailable");
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd); const named = fs.lstatSync(temporary);
      if (!privateOwned(opened, "file") || !privateOwned(named, "file") || !sameContents(opened, named)
        || !sameIdentity(opened, identity) || opened.size !== bytes.length) fail("state_unavailable");
      this.available(); fs.renameSync(temporary, this.filename(PRIVATE_MODEL_VAULT_FILE)); this.location();
      const installed = fs.lstatSync(this.filename(PRIVATE_MODEL_VAULT_FILE));
      if (!privateOwned(installed, "file") || !sameIdentity(installed, opened) || installed.size !== bytes.length) fail("state_unavailable");
      fs.fsyncSync(this.directoryFd); this.snapshotIdentity = installed; this.snapshot = next;
    } catch { this.held = true; fail("state_unavailable"); }
    finally {
      bytes.fill(0); if (fd !== undefined) fs.closeSync(fd);
      try {
        this.location(); const named = exists(temporary);
        if (named && identity && privateOwned(named, "file") && sameIdentity(named, identity)) fs.unlinkSync(temporary);
      } catch { /* Preserve ambiguous files; do not follow replacement paths. */ }
    }
  }
}
