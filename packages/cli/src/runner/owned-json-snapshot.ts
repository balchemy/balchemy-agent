/** Private snapshot IO under an existing daemon writer; no domain transitions. */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { privateOwned, sameIdentity } from "./kernel-lock.js";
import { isRecord } from "./protocol.js";

export class OwnedJsonSnapshotError extends Error {
  constructor(readonly code: "state_unavailable" | "snapshot_too_large") {
    super(`Private snapshot ${code}`); this.name = "OwnedJsonSnapshotError";
  }
}
export interface OwnedJsonSnapshotOptions<T> {
  directory: string;
  snapshotFile: string;
  markerFile: string;
  marker: Record<string, unknown>;
  maximumBytes: number;
  initial: T;
  decode(value: unknown): T;
  /** Must throw unless the caller retains its existing exclusive daemon writer. */
  assertAvailable(): void;
}
function fail(): never { throw new OwnedJsonSnapshotError("state_unavailable"); }
function exists(filename: string): fs.Stats | undefined {
  try { return fs.lstatSync(filename); }
  catch (error: unknown) { if (isRecord(error) && error.code === "ENOENT") return undefined; throw error; }
}
function ancestors(directory: string): void {
  let current = path.parse(directory).root;
  for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
}
function sameContents(a: fs.Stats, b: fs.Stats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function markerIdentity(value: unknown): string {
  if (!isRecord(value)) fail();
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
}

export class OwnedJsonSnapshot<T> {
  readonly directory: string;
  private readonly options: OwnedJsonSnapshotOptions<T>;
  private readonly directoryFd: number;
  private readonly directoryIdentity: fs.Stats;
  private snapshot: T;
  private snapshotIdentity?: fs.Stats;
  private markerFileIdentity?: fs.Stats;
  private held = false;
  private closed = false;

  constructor(options: OwnedJsonSnapshotOptions<T>) {
    if (typeof options.directory !== "string" || !path.isAbsolute(options.directory) || !Number.isSafeInteger(options.maximumBytes)
      || options.maximumBytes < 1 || options.maximumBytes > 64 * 1024 * 1024
      || !/^[a-z][a-z0-9.-]{0,100}$/.test(options.snapshotFile)
      || !/^[a-z][a-z0-9.-]{0,100}$/.test(options.markerFile)
      || options.snapshotFile === options.markerFile || typeof options.assertAvailable !== "function"
      || typeof options.decode !== "function" || !isRecord(options.marker)) fail();
    this.options = { ...options, marker: structuredClone(options.marker) };
    this.directory = path.resolve(options.directory);
    this.snapshot = structuredClone(options.initial);
    let fd: number | undefined;
    try {
      options.assertAvailable(); ancestors(this.directory);
      const named = fs.lstatSync(this.directory);
      fd = fs.openSync(this.directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const opened = fs.fstatSync(fd);
      if (!privateOwned(named, "directory") || !privateOwned(opened, "directory") || !sameIdentity(named, opened)) fail();
      this.directoryFd = fd; this.directoryIdentity = opened;
      const marker = exists(this.filename(options.markerFile));
      const saved = exists(this.filename(options.snapshotFile));
      if (!!marker !== !!saved) fail();
      if (marker && saved) {
        const markerRead = this.readFile(options.markerFile, 1024);
        if (markerIdentity(markerRead.value) !== markerIdentity(this.options.marker)) fail();
        this.markerFileIdentity = markerRead.identity;
        const snapshotRead = this.readFile(options.snapshotFile, options.maximumBytes);
        this.snapshot = options.decode(snapshotRead.value);
        this.snapshotIdentity = snapshotRead.identity;
        this.assertAvailable();
      } else {
        this.snapshot = options.decode(structuredClone(options.initial));
        // A partial initialization is held; neither one-sided loss is reset.
        this.writeMarker(); this.commit(this.snapshot);
      }
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      fail();
    }
  }

  read(): T { this.assertAvailable(); return structuredClone(this.snapshot); }
  assertAvailable(): void {
    if (this.closed || this.held) fail();
    try {
      this.location();
      this.checkArtifact(this.options.markerFile, this.markerFileIdentity);
      this.checkArtifact(this.options.snapshotFile, this.snapshotIdentity);
    } catch { this.held = true; fail(); }
  }
  close(): void { if (!this.closed) { this.closed = true; fs.closeSync(this.directoryFd); } }

  commit(next: T): void {
    let bytes: Buffer;
    try { bytes = Buffer.from(JSON.stringify(next), "utf8"); }
    catch { this.held = true; fail(); }
    if (bytes.length > this.options.maximumBytes) { bytes.fill(0); throw new OwnedJsonSnapshotError("snapshot_too_large"); }
    let fd: number | undefined;
    let temporaryIdentity: fs.Stats | undefined;
    const temporary = this.filename(`.${this.options.snapshotFile}-${randomUUID()}.tmp`);
    try {
      this.assertAvailable();
      fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      temporaryIdentity = fs.fstatSync(fd);
      if (!privateOwned(temporaryIdentity, "file")) fail();
      fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd); const named = fs.lstatSync(temporary);
      if (!privateOwned(opened, "file") || !privateOwned(named, "file") || !sameContents(opened, named)
        || !sameIdentity(opened, temporaryIdentity) || opened.size !== bytes.length) fail();
      this.assertAvailable();
      fs.renameSync(temporary, this.filename(this.options.snapshotFile));
      this.location();
      const installed = fs.lstatSync(this.filename(this.options.snapshotFile));
      if (!privateOwned(installed, "file") || !sameIdentity(installed, opened) || installed.size !== bytes.length) fail();
      fs.fsyncSync(this.directoryFd);
      this.snapshotIdentity = installed; this.snapshot = structuredClone(next);
    } catch { this.held = true; fail(); }
    finally {
      bytes.fill(0);
      if (fd !== undefined) fs.closeSync(fd);
      try {
        this.location(); const candidate = exists(temporary);
        if (candidate && temporaryIdentity && privateOwned(candidate, "file") && sameIdentity(candidate, temporaryIdentity)) fs.unlinkSync(temporary);
      } catch { /* Preserve ambiguous files; never follow replaced paths. */ }
    }
  }

  private filename(name: string): string { return path.join(this.directory, name); }
  private location(): void {
    this.options.assertAvailable(); ancestors(this.directory);
    const named = fs.lstatSync(this.directory); const opened = fs.fstatSync(this.directoryFd);
    if (!privateOwned(named, "directory") || !privateOwned(opened, "directory")
      || !sameIdentity(named, this.directoryIdentity) || !sameIdentity(opened, this.directoryIdentity)) fail();
  }
  private checkArtifact(name: string, identity: fs.Stats | undefined): void {
    const named = exists(this.filename(name));
    if (identity ? !named || !privateOwned(named, "file") || !sameContents(named, identity) : !!named) fail();
  }
  private readFile(name: string, maximum: number): { value: unknown; identity: fs.Stats } {
    this.location(); const filename = this.filename(name); const named = fs.lstatSync(filename);
    if (!privateOwned(named, "file") || named.size === 0 || named.size > maximum) fail();
    const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const bytes = Buffer.alloc(maximum + 1);
    try {
      const opened = fs.fstatSync(fd);
      if (!privateOwned(opened, "file") || !sameContents(named, opened)) fail();
      let length = 0;
      while (length < bytes.length) {
        const count = fs.readSync(fd, bytes, length, bytes.length - length, null);
        if (!count) break; length += count;
      }
      if (length !== opened.size || length > maximum || !sameContents(opened, fs.fstatSync(fd))
        || !sameContents(opened, fs.lstatSync(filename))) fail();
      this.location();
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length));
      const value: unknown = JSON.parse(text);
      if (JSON.stringify(value) !== text) fail();
      return { value, identity: opened };
    } finally { bytes.fill(0); fs.closeSync(fd); }
  }
  private writeMarker(): void {
    this.assertAvailable();
    const filename = this.filename(this.options.markerFile);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(this.options.marker)); fs.fsyncSync(fd);
      const opened = fs.fstatSync(fd); const named = fs.lstatSync(filename);
      if (!privateOwned(opened, "file") || !privateOwned(named, "file") || !sameContents(opened, named)) fail();
      this.location(); fs.fsyncSync(this.directoryFd); this.markerFileIdentity = named;
    } finally { fs.closeSync(fd); }
  }
}
