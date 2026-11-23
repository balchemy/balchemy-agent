/** Phase 1 keep-awake (owner decision of 17 Nov 2026). While any agent of this runner is live_armed or holds an open, exit-pending or
 * held position, the daemon keeps exactly ONE sleep inhibitor child, so an idle computer does not sleep and stop the stop-loss and
 * take-profit exits:
 * - darwin: `/usr/bin/caffeinate -i -w <daemon pid>` (it also ends by itself when the daemon exits);
 * - linux, only when systemd-inhibit exists: `systemd-inhibit --what=sleep:idle --who=balchemy --why="Balchemy runner protecting open
 *   positions" --mode=block tail --pid=<daemon pid> -f /dev/null` (ends by itself when the daemon exits, even on SIGKILL);
 * - anything else (win32 included): none, reported `unavailable` / `unsupported_platform`.
 * The daemon runs with an empty environment (no PATH), so the tools are looked up at fixed absolute paths only. A missing tool, a spawn
 * error or a child that exits never reaches the daemon (an `error` listener is attached before anything else): the state reads
 * `unavailable` and a new child is tried at most once per retry interval, never in a loop. Defensively the child gets fds 3 and 4
 * replaced by /dev/null: fd 4 of the daemon is its inherited writer lock (kernel-lock.ts INHERITED_WRITER_FD), which no child may hold
 * even if that descriptor is not close-on-exec (a held writer lock would block the next runner start). It runs in its own process
 * group, and stopping it signals the whole group (systemd-inhibit and its sleep). A closed laptop lid on battery can still sleep: no
 * user-space inhibitor prevents that. Nothing here is sent to Balchemy; the owner reads it in `runner status` and the cockpit. */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn as spawnChild, type ChildProcess } from "node:child_process";
import { inspectDirectory, readDaemonMetadata, readLocalProfile } from "./metadata.js";
import { encodeFrame, exactKeys, FrameReader, isId, isRecord } from "./protocol.js";

export const RUNNER_KEEP_AWAKE_METHODS = ["caffeinate", "systemd_inhibit"] as const;
export type RunnerKeepAwakeMethod = typeof RUNNER_KEEP_AWAKE_METHODS[number];
export const RUNNER_KEEP_AWAKE_REASONS = ["unsupported_platform", "tool_missing", "child_exited"] as const;
export type RunnerKeepAwakeReason = typeof RUNNER_KEEP_AWAKE_REASONS[number];
/** `active`: one inhibitor runs; `idle`: nothing to protect (no agent armed, no open position); `unavailable`: protection is needed
 * but no inhibitor runs, for `reason`. */
export type RunnerKeepAwake = { state: "active"; method: RunnerKeepAwakeMethod } | { state: "idle" }
  | { state: "unavailable"; reason: RunnerKeepAwakeReason };

/** How often the daemon re-checks (also at once after every arm, disarm and control). */
export const PRIVATE_KEEP_AWAKE_POLL_MS = 30_000;
/** A child that failed or exited is started again at most this often. */
export const PRIVATE_KEEP_AWAKE_RETRY_MS = 5 * 60_000;
export const PRIVATE_KEEP_AWAKE_WHY = "Balchemy runner protecting open positions";
const CAFFEINATE = ["/usr/bin/caffeinate"];
const SYSTEMD_INHIBIT = ["/usr/bin/systemd-inhibit", "/bin/systemd-inhibit"];
/** `tail --pid=<daemon> -f /dev/null` ends by itself when the daemon dies (even on SIGKILL), so a stale inhibitor never keeps the
 * computer awake after the runner is gone (Phase 1 review, 17 Nov 2026; `sleep infinity` would outlive it). */
const TAIL = ["/usr/bin/tail", "/bin/tail"];

/** The fixed command for this platform, or why there is none. */
export function privateKeepAwakeCommand(platform: NodeJS.Platform, pid: number, exists: (file: string) => boolean):
  { method: RunnerKeepAwakeMethod; command: string; args: string[] } | { reason: "unsupported_platform" | "tool_missing" } {
  const find = (candidates: readonly string[]): string | undefined => {
    for (const candidate of candidates) { try { if (exists(candidate)) return candidate; } catch { /* Not usable. */ } }
    return undefined;
  };
  if (platform === "darwin") {
    const caffeinate = find(CAFFEINATE);
    if (!caffeinate || !Number.isSafeInteger(pid) || pid <= 0) return { reason: "tool_missing" };
    return { method: "caffeinate", command: caffeinate, args: ["-i", "-w", String(pid)] };
  }
  if (platform === "linux") {
    const inhibit = find(SYSTEMD_INHIBIT); const tail = find(TAIL);
    if (!inhibit || !tail || !Number.isSafeInteger(pid) || pid <= 0) return { reason: "tool_missing" };
    return { method: "systemd_inhibit", command: inhibit,
      args: ["--what=sleep:idle", "--who=balchemy", `--why=${PRIVATE_KEEP_AWAKE_WHY}`, "--mode=block", tail, `--pid=${pid}`, "-f", "/dev/null"] };
  }
  return { reason: "unsupported_platform" };
}

/** One started inhibitor. `stop` never throws. */
export interface PrivateKeepAwakeProcess { stop(): void }
/** Starts one inhibitor; `onExit` runs once when it exits or fails to start (a missing binary is an exit). May throw. */
export type PrivateKeepAwakeSpawn = (command: string, args: readonly string[], onExit: () => void) => PrivateKeepAwakeProcess;

/** Production spawn: no shell, empty environment, root cwd, its own process group, fds 0-4 never inherited from the daemon. */
export const spawnPrivateKeepAwake: PrivateKeepAwakeSpawn = (command, args, onExit) => {
  const blank = fs.openSync("/dev/null", "r");
  let child: ChildProcess;
  try {
    child = spawnChild(command, [...args], { shell: false, env: {}, cwd: "/", detached: true, windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", blank, blank] });
  } finally { try { fs.closeSync(blank); } catch { /* The child holds its own copy. */ } }
  let ended = false;
  const end = (): void => { if (ended) return; ended = true; try { onExit(); } catch { /* Never reaches the daemon. */ } };
  child.once("error", end);
  child.once("exit", end);
  child.unref();
  return { stop: () => {
    const pid = child.pid;
    if (pid !== undefined && !ended) { try { process.kill(-pid, "SIGTERM"); return; } catch { /* Not a group leader: the child alone. */ } }
    try { child.kill("SIGTERM"); } catch { /* Already gone. */ }
  } };
};

export interface PrivateKeepAwakeOptions {
  /** True while protection is needed (an agent live_armed, or an open, exit-pending or held position). A throw reads as needed. */
  needed(): boolean;
  platform?: NodeJS.Platform;
  /** The daemon's own pid (caffeinate -w). */
  pid?: number;
  spawn?: PrivateKeepAwakeSpawn;
  exists?(file: string): boolean;
  now?(): number;
  retryMs?: number;
}

interface Entry { method: RunnerKeepAwakeMethod; process: PrivateKeepAwakeProcess | null }

/** The daemon's single inhibitor. Every method is synchronous and never throws. */
export class PrivateKeepAwake {
  readonly #options: PrivateKeepAwakeOptions;
  #child: Entry | undefined;
  #failure: { reason: RunnerKeepAwakeReason; at: number } | undefined;
  #needed = false;
  #closed = false;
  constructor(options: PrivateKeepAwakeOptions) { this.#options = options; }
  #now(): number { try { return (this.#options.now ?? Date.now)(); } catch { return Date.now(); } }

  /** Starts or stops the inhibitor for the current need; returns the resulting state. */
  refresh(): RunnerKeepAwake {
    if (this.#closed) return this.status();
    let needed: boolean;
    // An unreadable state keeps the computer awake: harmless, and never weaker than the protection it stands for.
    try { needed = this.#options.needed() !== false; } catch { needed = true; }
    this.#needed = needed;
    if (!needed) { this.#stop(); this.#failure = undefined; return this.status(); }
    if (this.#child) return this.status();
    let command: ReturnType<typeof privateKeepAwakeCommand>;
    try {
      command = privateKeepAwakeCommand(this.#options.platform ?? process.platform, this.#options.pid ?? process.pid,
        this.#options.exists ?? ((file: string) => fs.statSync(file).isFile()));
    } catch { command = { reason: "tool_missing" }; }
    if ("reason" in command) { this.#failure = { reason: command.reason, at: this.#now() }; return this.status(); }
    const retryMs = this.#options.retryMs ?? PRIVATE_KEEP_AWAKE_RETRY_MS;
    if (this.#failure?.reason === "child_exited" && this.#now() - this.#failure.at < retryMs) return this.status();
    const entry: Entry = { method: command.method, process: null };
    this.#child = entry;
    try {
      const started = (this.#options.spawn ?? spawnPrivateKeepAwake)(command.command, command.args, () => this.#exited(entry));
      if (this.#child === entry) { entry.process = started; this.#failure = undefined; } else stopQuietly(started);
    } catch {
      if (this.#child === entry) this.#child = undefined;
      this.#failure = { reason: "child_exited", at: this.#now() };
    }
    return this.status();
  }

  status(): RunnerKeepAwake {
    if (this.#child && !this.#closed) return { state: "active", method: this.#child.method };
    if (!this.#needed || this.#closed) return { state: "idle" };
    return { state: "unavailable", reason: this.#failure?.reason ?? "child_exited" };
  }

  /** Daemon shutdown: the inhibitor is stopped and none is started again. */
  close(): void { this.#closed = true; this.#stop(); }

  #exited(entry: Entry): void {
    if (this.#child !== entry) return;
    this.#child = undefined;
    if (!this.#closed) this.#failure = { reason: "child_exited", at: this.#now() };
  }

  #stop(): void {
    const entry = this.#child;
    this.#child = undefined;
    if (entry?.process) stopQuietly(entry.process);
  }
}
function stopQuietly(child: PrivateKeepAwakeProcess): void { try { child.stop(); } catch { /* Already gone. */ } }

export function parseRunnerKeepAwake(value: unknown): RunnerKeepAwake {
  if (!isRecord(value)) throw new Error("Invalid keep-awake state");
  if (value.state === "idle" && exactKeys(value, ["state"])) return { state: "idle" };
  if (value.state === "active" && exactKeys(value, ["state", "method"]) && RUNNER_KEEP_AWAKE_METHODS.includes(value.method as RunnerKeepAwakeMethod)) {
    return { state: "active", method: value.method as RunnerKeepAwakeMethod };
  }
  if (value.state === "unavailable" && exactKeys(value, ["state", "reason"]) && RUNNER_KEEP_AWAKE_REASONS.includes(value.reason as RunnerKeepAwakeReason)) {
    return { state: "unavailable", reason: value.reason as RunnerKeepAwakeReason };
  }
  throw new Error("Invalid keep-awake state");
}

// ---- owner-local read (channel private_keep_awake) ------------------------------------------------------------------------
/** Read-only; no agent, no secret. An older daemon refuses the channel, which reads as "not reported". */
export interface PrivateKeepAwakeRequest { channel: "private_keep_awake"; version: 1; id: string; localProfileId: string; instanceId: string }
export const PRIVATE_KEEP_AWAKE_ERRORS = ["invalid_request", "profile_conflict", "instance_conflict", "closing", "state_unavailable"] as const;
export type PrivateKeepAwakeError = typeof PRIVATE_KEEP_AWAKE_ERRORS[number];
export type PrivateKeepAwakeResponse = { channel: "private_keep_awake"; version: 1; id: string } & ({ ok: true; keepAwake: RunnerKeepAwake }
  | { ok: false; error: PrivateKeepAwakeError });

export function parsePrivateKeepAwakeRequest(value: unknown): PrivateKeepAwakeRequest {
  if (!isRecord(value) || !exactKeys(value, ["channel", "version", "id", "localProfileId", "instanceId"]) || value.channel !== "private_keep_awake"
    || value.version !== 1 || !isId(value.id) || !isId(value.localProfileId) || !isId(value.instanceId)) throw new Error("Invalid keep-awake request");
  return { channel: "private_keep_awake", version: 1, id: value.id, localProfileId: value.localProfileId, instanceId: value.instanceId };
}
/** The daemon's reply to a request that may not have parsed: the id is echoed only when it is a valid id. */
export function privateKeepAwakeReply(raw: unknown, result: RunnerKeepAwake | PrivateKeepAwakeError): PrivateKeepAwakeResponse {
  const id = isRecord(raw) && isId(raw.id) ? raw.id : "invalid";
  return typeof result === "string" ? { channel: "private_keep_awake", version: 1, id, ok: false, error: result }
    : { channel: "private_keep_awake", version: 1, id, ok: true, keepAwake: result };
}
function parseResponse(value: unknown, request: PrivateKeepAwakeRequest): RunnerKeepAwake {
  if (!isRecord(value) || value.channel !== "private_keep_awake" || value.version !== 1 || value.id !== request.id || value.ok !== true
    || !exactKeys(value, ["channel", "version", "id", "ok", "keepAwake"])) throw new Error("Invalid keep-awake response");
  return parseRunnerKeepAwake(value.keepAwake);
}

/** The running daemon's keep-awake state; null when no daemon runs, it is older (no such channel) or the read fails. */
function keepAwakeTarget(input: string): { socketPath: string; request: PrivateKeepAwakeRequest } | null {
  try {
    const directory = inspectDirectory(input);
    const profile = directory ? readLocalProfile(directory) : undefined;
    const metadata = directory && profile ? readDaemonMetadata(directory, profile) : undefined;
    if (!directory || !profile || !metadata) return null;
    const socketPath = path.join(directory, "control.sock");
    const folder = fs.lstatSync(directory); const socket = fs.lstatSync(socketPath);
    if (folder.isSymbolicLink() || !folder.isDirectory() || socket.isSymbolicLink() || !socket.isSocket() || (folder.mode & 0o077) !== 0
      || (socket.mode & 0o077) !== 0 || (process.getuid && (folder.uid !== process.getuid() || socket.uid !== process.getuid()))) return null;
    return { socketPath, request: parsePrivateKeepAwakeRequest({ channel: "private_keep_awake", version: 1, id: randomUUID(),
      localProfileId: profile.localProfileId, instanceId: metadata.instanceId }) };
  } catch { return null; }
}
export async function readRunnerKeepAwake(input: string): Promise<RunnerKeepAwake | null> {
  const target = keepAwakeTarget(input);
  if (!target) return null;
  const { socketPath, request } = target;
  return new Promise<RunnerKeepAwake | null>((resolve) => {
    const connection = net.createConnection({ path: socketPath }); const reader = new FrameReader(); let settled = false;
    const finish = (value: RunnerKeepAwake | null): void => { if (settled) return; settled = true; clearTimeout(deadline); connection.destroy(); resolve(value); };
    const deadline = setTimeout(() => finish(null), 3_000);
    connection.once("close", () => finish(null)); connection.on("error", () => finish(null));
    connection.on("connect", () => connection.end(encodeFrame(request)));
    connection.on("data", (chunk: Buffer) => { try { reader.push(chunk); } catch { finish(null); } });
    connection.on("end", () => { try { finish(parseResponse(reader.finish(), request)); } catch { finish(null); } });
  });
}

// ---- owner text ---------------------------------------------------------------------------------------------------------
export const PRIVATE_KEEP_AWAKE_LID_NOTE = "A closed laptop lid on battery can still put the computer to sleep; keep it open or on power.";
const METHOD_WORDS: Readonly<Record<RunnerKeepAwakeMethod, string>> = Object.freeze({ caffeinate: "caffeinate", systemd_inhibit: "systemd-inhibit" });

/** `runner status`: one line (null: this runner does not report it). */
export function formatRunnerKeepAwake(value: RunnerKeepAwake | null): string {
  if (!value) return "Keep-awake: not reported by this runner (a runner older than this CLI; restart it to use this version).";
  if (value.state === "active") return `Keep-awake: on (${METHOD_WORDS[value.method]}): this computer is kept from idle sleep while an agent is armed or holds open positions. ${PRIVATE_KEEP_AWAKE_LID_NOTE}`;
  if (value.state === "idle") return "Keep-awake: off (no agent is armed and no position is open).";
  if (value.reason === "unsupported_platform") return `Keep-awake: not available on this system. Keep the computer from sleeping yourself while an agent is armed or holds open positions. ${PRIVATE_KEEP_AWAKE_LID_NOTE}`;
  if (value.reason === "tool_missing") return `Keep-awake: not available (caffeinate or systemd-inhibit not found). Keep the computer from sleeping yourself while an agent is armed or holds open positions. ${PRIVATE_KEEP_AWAKE_LID_NOTE}`;
  return "Keep-awake: the sleep inhibitor stopped; the runner starts it again within 5 minutes. Keep the computer awake meanwhile.";
}
/** The cockpit side panel: one short line. */
export function cockpitKeepAwakeLine(value: RunnerKeepAwake | null): string {
  if (!value) return "Keep-awake: not reported";
  if (value.state === "active") return "Keep-awake: on (lid closed on battery can still sleep)";
  if (value.state === "idle") return "Keep-awake: off (nothing to protect)";
  return "Keep-awake: unavailable; keep this computer awake";
}
