import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

export const GATE_FILE = "launcher.lock";
export const WRITER_FILE = "control.lock";
export const INHERITED_WRITER_FD = 4;
/** One unfinished swap per trading wallet (plan decision 11): the file is keyed by the public address only. */
export type WalletLockFile = `wallet-${string}.lock`;
type LockName = typeof GATE_FILE | typeof WRITER_FILE | WalletLockFile;
/** A wallet lock file name (walletLockFile); also the recovery inventory's pattern for it (lifecycle.ts). */
export const WALLET_LOCK = /^wallet-[0-9a-f]{64}\.lock$/;
export function walletLockFile(walletAddress: string): WalletLockFile {
  if (typeof walletAddress !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(walletAddress)) throw new RunnerLockError("unsafe_lock");
  return `wallet-${createHash("sha256").update(JSON.stringify(["balchemy.runner-wallet-lock.v1", walletAddress]), "utf8").digest("hex")}.lock`;
}
type NativeLocks = Pick<typeof import("fs-native-extensions"), "tryLock">;
let native: NativeLocks | undefined;

export class RunnerLockError extends Error {
  constructor(readonly code: "lock_busy" | "unsafe_lock" | "unsupported_locking") {
    super(`Local runner ${code}`);
    this.name = "RunnerLockError";
  }
}

function binding(): NativeLocks {
  if (native) return native;
  if (!["x64", "arm64"].includes(process.arch)
    || (process.platform !== "linux" && process.platform !== "darwin")
    || (process.platform === "darwin" && Number(os.release().split(".")[0]) < 21)) throw new RunnerLockError("unsupported_locking");
  if (process.platform === "linux") {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
    if (!report.header?.glibcVersionRuntime) throw new RunnerLockError("unsupported_locking");
  }
  try { native = createRequire(import.meta.url)("fs-native-extensions") as NativeLocks; }
  catch { throw new RunnerLockError("unsupported_locking"); }
  return native;
}

export function sameIdentity(a: fs.Stats, b: fs.Stats): boolean { return a.dev === b.dev && a.ino === b.ino; }
export function privateOwned(stat: fs.Stats, kind: "file" | "directory" | "socket"): boolean {
  return !stat.isSymbolicLink() && (kind === "file" ? stat.isFile() : kind === "directory" ? stat.isDirectory() : stat.isSocket())
    && (stat.mode & 0o7777) === (kind === "directory" ? 0o700 : 0o600)
    && (kind === "directory" || stat.nlink === 1) && !!process.getuid && stat.uid === process.getuid();
}
function validFile(stat: fs.Stats): boolean { return privateOwned(stat, "file") && stat.size === 0; }

/** Files are permanent coordination identities. Only closing an FD releases its
 * reference: explicit unlock would also unlock the child's inherited reference. */
export class RunnerKernelLock {
  private closed = false;
  private constructor(readonly directory: string, readonly name: LockName, readonly fd: number,
    private readonly parent: number, private readonly identity: fs.Stats, private readonly directoryIdentity: fs.Stats) {}

  static acquire(directory: string, name: typeof GATE_FILE | typeof WRITER_FILE): RunnerKernelLock {
    return RunnerKernelLock.open(directory, name);
  }

  /** Wallet-scoped exclusive lock in the private runner directory, held from an execution build until a terminal or
   * unknown outcome. Process exit releases it; the durable spend ledger keeps an unfinished reservation blocking. */
  static acquireWallet(directory: string, walletAddress: string): RunnerKernelLock {
    return RunnerKernelLock.open(directory, walletLockFile(walletAddress));
  }

  /** Only the private host bootstrap adopts FD4; the parent locks before spawn. */
  static inheritWriter(directory: string, fd = INHERITED_WRITER_FD): RunnerKernelLock {
    if (fd !== INHERITED_WRITER_FD) throw new RunnerLockError("unsafe_lock");
    return RunnerKernelLock.open(directory, WRITER_FILE, fd);
  }

  private static open(directory: string, name: LockName, inherited?: number): RunnerKernelLock {
    const locks = binding();
    let parent: number | undefined;
    let fd: number | undefined = inherited;
    try {
      if (name !== GATE_FILE && name !== WRITER_FILE && !WALLET_LOCK.test(name)) throw new RunnerLockError("unsafe_lock");
      if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory) throw new RunnerLockError("unsafe_lock");
      const namedParent = fs.lstatSync(directory);
      parent = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      const directoryIdentity = fs.fstatSync(parent);
      if (!privateOwned(namedParent, "directory") || !sameIdentity(namedParent, directoryIdentity)) throw new RunnerLockError("unsafe_lock");
      const filename = path.join(directory, name);
      if (fd === undefined) {
        try {
          fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          fs.fsyncSync(fd); fs.fsyncSync(parent);
        } catch (error: unknown) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
          fd = fs.openSync(filename, fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        }
      }
      const identity = fs.fstatSync(fd);
      const named = fs.lstatSync(filename);
      if (!validFile(identity) || !validFile(named) || !sameIdentity(identity, named)) throw new RunnerLockError("unsafe_lock");
      if (!locks.tryLock(fd, 0, 0, { shared: false })) throw new RunnerLockError("lock_busy");
      const held = new RunnerKernelLock(directory, name, fd, parent, identity, directoryIdentity);
      held.assertValid();
      return held;
    } catch (error: unknown) {
      if (fd !== undefined) fs.closeSync(fd);
      if (parent !== undefined) fs.closeSync(parent);
      if (error instanceof RunnerLockError) throw error;
      throw new RunnerLockError("unsafe_lock");
    }
  }

  assertValid(): void {
    try {
      const named = fs.lstatSync(path.join(this.directory, this.name));
      const opened = fs.fstatSync(this.fd);
      const parent = fs.lstatSync(this.directory);
      if (this.closed || !validFile(named) || !validFile(opened) || !sameIdentity(named, this.identity) || !sameIdentity(opened, this.identity)
        || !privateOwned(parent, "directory") || !sameIdentity(parent, this.directoryIdentity)
        || !sameIdentity(fs.fstatSync(this.parent), this.directoryIdentity)) throw new Error("changed identity");
    } catch { throw new RunnerLockError("unsafe_lock"); }
  }

  assertWriter(directory: string): void {
    if (this.name !== WRITER_FILE || this.directory !== directory) throw new RunnerLockError("unsafe_lock");
    this.assertValid();
  }
  syncDirectory(): void { this.assertValid(); fs.fsyncSync(this.parent); }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { fs.closeSync(this.fd); } finally { fs.closeSync(this.parent); }
  }
}

/** Read-only inspection never mistakes a permanent file for a live holder. */
export function inspectKernelFile(directory: string, name: LockName): boolean {
  try {
    if (!validFile(fs.lstatSync(path.join(directory, name)))) throw new RunnerLockError("unsafe_lock");
    return true;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw new RunnerLockError("unsafe_lock");
  }
}
