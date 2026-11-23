import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { exactKeys, isId, isRecord, isTimestamp, isVersion } from "./protocol.js";
import { GATE_FILE, RunnerKernelLock } from "./kernel-lock.js";

export const PROFILE_FILE = "local-profile.json";
export const DAEMON_FILE = "daemon-instance.json";
export const START_LOCK = GATE_FILE;
export interface LocalProfile { schemaVersion: 1; localProfileId: string; pairing: "unpaired" }
export interface DaemonMetadata { schemaVersion: 1 | 2; localProfileId: string; instanceId: string; pid: number; startedAt: number }

export class RunnerLifecycleError extends Error {
  constructor(readonly code: "invalid_arguments" | "metadata_invalid" | "recovery_required" | "start_failed" | "not_running" | "agent_not_registered" | "agent_limit" | "control_rejected" | "shutdown_unknown") {
    super(`Local runner ${code}`);
    this.name = "RunnerLifecycleError";
  }
}

export function exists(filePath: string): boolean {
  try { fs.lstatSync(filePath); return true; }
  catch (error: unknown) {
    if (isRecord(error) && error.code === "ENOENT") return false;
    throw new RunnerLifecycleError("metadata_invalid");
  }
}

export function inspectDirectory(directory: string): string | undefined {
  if (!exists(directory)) return undefined;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0
    || (process.getuid && stat.uid !== process.getuid())) throw new RunnerLifecycleError("metadata_invalid");
  return fs.realpathSync(directory);
}

function readJson(filePath: string): unknown {
  let descriptor: number | undefined;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 4096
      || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error("invalid metadata");
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error("changed metadata");
    const text = fs.readFileSync(descriptor, "utf8");
    const after = fs.lstatSync(filePath);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs
      || after.ctimeMs !== stat.ctimeMs) throw new Error("changed metadata");
    return JSON.parse(text) as unknown;
  } catch { throw new RunnerLifecycleError("metadata_invalid"); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function readLocalProfile(directory: string): LocalProfile | undefined {
  const filePath = path.join(directory, PROFILE_FILE);
  if (!exists(filePath)) return undefined;
  const value = readJson(filePath);
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "pairing"])
    || value.schemaVersion !== 1 || !isId(value.localProfileId) || value.pairing !== "unpaired") throw new RunnerLifecycleError("metadata_invalid");
  return value as unknown as LocalProfile;
}

export function readDaemonMetadata(directory: string, profile: LocalProfile): DaemonMetadata | undefined {
  const filePath = path.join(directory, DAEMON_FILE);
  if (!exists(filePath)) return undefined;
  const value = readJson(filePath);
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "localProfileId", "instanceId", "pid", "startedAt"])
    || (value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.localProfileId !== profile.localProfileId || !isId(value.instanceId)
    || !isVersion(value.pid) || !isTimestamp(value.startedAt)) throw new RunnerLifecycleError("metadata_invalid");
  return value as unknown as DaemonMetadata;
}

export function writeMetadata(directory: string, filename: typeof PROFILE_FILE | typeof DAEMON_FILE, value: LocalProfile | DaemonMetadata, writer: RunnerKernelLock): void {
  writer.assertWriter(directory);
  const temporary = path.join(directory, `.metadata-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    writer.assertWriter(directory);
    fs.renameSync(temporary, path.join(directory, filename));
    const parent = fs.openSync(directory, "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } catch { throw new RunnerLifecycleError("metadata_invalid"); }
  finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { fs.unlinkSync(temporary); } catch { /* Only this write's temporary. */ }
  }
}

export function removeOwnedDaemonMetadata(directory: string, profile: LocalProfile, instanceId: string, writer: RunnerKernelLock): void {
  writer.assertWriter(directory);
  const current = readDaemonMetadata(directory, profile);
  if (!current || current.instanceId !== instanceId) throw new RunnerLifecycleError("recovery_required");
  fs.unlinkSync(path.join(directory, DAEMON_FILE));
  const parent = fs.openSync(directory, "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

export function acquireLauncherLock(directory: string): () => void {
  const gate = RunnerKernelLock.acquire(directory, START_LOCK);
  return () => gate.close();
}
