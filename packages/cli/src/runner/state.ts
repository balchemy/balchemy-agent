import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { GATE_FILE, WRITER_FILE, RunnerKernelLock, RunnerLockError } from "./kernel-lock.js";
import {
  exactKeys, failure, isId, isRecord, isTimestamp, parseAgentState, parseRequest, parseResponse,
  type RunnerAgentEntries, type RunnerAgentState, type RunnerRequest, type RunnerResponse,
} from "./protocol.js";

const MAX_AGENTS = 64;
const MAX_RECEIPTS = 1024;
/** Receipts older than this are pruned at the next write: far beyond the 30 s command lifetime and the web's recovery of
 * unacknowledged receipts (an older recovery then reads `receipt_missing`, never a reapplication). */
export const RUNNER_RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Slots only disarm and stop may use; when even those are taken they evict the oldest receipt: never refused for room. */
export const RUNNER_RECEIPT_SAFETY_RESERVE = 64;
/** Arming needs this many free ordinary slots, so pause/resume of the armed agent cannot be refused for room right after. */
export const RUNNER_RECEIPT_ARM_FREE = 64;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_FILE = "control-state.json";
/** Compatibility export: this path now contains a permanent regular lockfile. */
export const LOCK_DIRECTORY = WRITER_FILE;
export const INITIALIZED_FILE = "control.initialized";

interface Receipt {
  request: Exclude<RunnerRequest, { action: "status" }>;
  response: RunnerResponse;
  recordedAt: number;
}
interface Snapshot {
  schemaVersion: 1;
  ownerId: string;
  agents: RunnerAgentState[];
  receipts: Receipt[];
}

export type RunnerReceiptLookup =
  | { kind: "found"; response: RunnerResponse }
  | { kind: "missing" | "conflict" | "unavailable" };

/** Why an internal entries transition wrote nothing because the store refused it (nothing changed). */
export type RunnerEntriesRefusal = "unknown_agent" | "journal_full" | "state_unavailable";
/** `holdEntries`: `held` paused new entries now (state.version is the hold version); `already_paused` and `not_armed` changed
 * nothing (no version bump, no receipt). */
export type RunnerEntriesHold =
  | { kind: "held" | "already_paused" | "not_armed"; state: RunnerAgentState }
  | { kind: "refused"; error: RunnerEntriesRefusal };
/** `releaseEntries`: `released` enabled new entries again; every other kind changed nothing. `version_changed`: any control
 * (a Hub or CLI pause, disarm, stop or re-arm) moved the state since the hold, so the owner's action stands. */
export type RunnerEntriesRelease =
  | { kind: "released" | "not_armed" | "version_changed" | "not_paused"; state: RunnerAgentState }
  | { kind: "refused"; error: RunnerEntriesRefusal };
type EntriesTransition = { kind: "applied"; state: RunnerAgentState } | { kind: "unchanged"; state: RunnerAgentState }
  | { kind: "not_armed"; state: RunnerAgentState } | { kind: "version_changed"; state: RunnerAgentState } | { kind: "refused"; error: RunnerEntriesRefusal };

export class RunnerStateError extends Error {
  constructor(readonly code: "invalid_options" | "unsafe_path" | "store_locked" | "state_unavailable") {
    super(`Local runner ${code}`);
    this.name = "RunnerStateError";
  }
}

function safeOwned(stat: fs.Stats, directory: boolean): boolean {
  return !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile())
    && (stat.mode & 0o077) === 0
    && (process.getuid === undefined || stat.uid === process.getuid());
}

export function requirePrivateDirectory(directory: string): string {
  const resolved = path.resolve(directory);
  try {
    if (!fs.existsSync(resolved)) fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    if (!safeOwned(fs.lstatSync(resolved), true)) {
      throw new RunnerStateError("unsafe_path");
    }
    return fs.realpathSync(resolved);
  } catch { throw new RunnerStateError("unsafe_path"); }
}

function decodeSnapshot(value: unknown, ownerId: string): Snapshot {
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "ownerId", "agents", "receipts"])
    || value.schemaVersion !== 1 || value.ownerId !== ownerId
    || !Array.isArray(value.agents) || value.agents.length > MAX_AGENTS
    || !Array.isArray(value.receipts) || value.receipts.length > MAX_RECEIPTS) throw new RunnerStateError("state_unavailable");
  const agents = value.agents.map(parseAgentState);
  const agentIds = new Set(agents.map((agent) => agent.agentId));
  if (agentIds.size !== agents.length) throw new RunnerStateError("state_unavailable");
  const commandIds = new Set<string>();
  const receipts = value.receipts.map((entry): Receipt => {
    if (!isRecord(entry) || !exactKeys(entry, ["request", "response", "recordedAt"]) || !isTimestamp(entry.recordedAt)) {
      throw new RunnerStateError("state_unavailable");
    }
    const request = parseRequest(entry.request);
    const response = parseResponse(entry.response);
    const agent = agents.find((item) => item.agentId === request.agentId);
    if (request.action === "status" || commandIds.has(request.id) || !agent
      || response.id !== request.id || response.hub || !response.state || response.state.agentId !== request.agentId
      || response.state.version > agent.version) throw new RunnerStateError("state_unavailable");
    commandIds.add(request.id);
    return { request, response, recordedAt: entry.recordedAt };
  });
  return { schemaVersion: 1, ownerId, agents, receipts };
}

function copy<T>(value: T): T { return structuredClone(value); }

/** Single writer, bounded durable control receipts. This is NOT a trade journal. */
export class RunnerStateStore {
  readonly directory: string;
  private snapshot: Snapshot;
  private held = false;
  private closed = false;
  private readonly writer: RunnerKernelLock;
  private readonly ownsWriter: boolean;

  constructor(options: { directory: string; ownerId: string; agentIds: string[]; writerLock?: RunnerKernelLock }) {
    if (!isId(options.ownerId) || !Array.isArray(options.agentIds) || options.agentIds.length === 0
      || options.agentIds.length > MAX_AGENTS || options.agentIds.some((id) => !isId(id))
      || new Set(options.agentIds).size !== options.agentIds.length) throw new RunnerStateError("invalid_options");
    this.directory = requirePrivateDirectory(options.directory);
    let gate: RunnerKernelLock | undefined;
    let acquiredWriter: RunnerKernelLock | undefined;
    this.ownsWriter = options.writerLock === undefined;
    try {
      if (this.ownsWriter) gate = RunnerKernelLock.acquire(this.directory, GATE_FILE);
      acquiredWriter = options.writerLock ?? RunnerKernelLock.acquire(this.directory, WRITER_FILE);
      this.writer = acquiredWriter;
      if (!(this.writer instanceof RunnerKernelLock)) throw new RunnerStateError("unsafe_path");
      this.writer.assertWriter(this.directory);
    } catch (error: unknown) {
      if (this.ownsWriter) acquiredWriter?.close();
      gate?.close();
      if (error instanceof RunnerLockError && error.code === "unsupported_locking") throw error;
      throw new RunnerStateError("store_locked");
    }
    this.snapshot = { schemaVersion: 1, ownerId: options.ownerId, agents: [], receipts: [] };
    try {
      for (const artifact of ["control.sock", "daemon-instance.json"]) {
        try { fs.lstatSync(path.join(this.directory, artifact)); throw new RunnerStateError("state_unavailable"); }
        catch (error: unknown) { if (!isRecord(error) || error.code !== "ENOENT") throw error; }
      }
      const snapshotPath = path.join(this.directory, SNAPSHOT_FILE);
      const markerPath = path.join(this.directory, INITIALIZED_FILE);
      let initialized = false;
      try {
        const marker = fs.lstatSync(markerPath);
        if (!safeOwned(marker, false) || marker.nlink !== 1 || marker.size !== 2
          || fs.readFileSync(markerPath, "utf8") !== "1\n") throw new RunnerStateError("state_unavailable");
        initialized = true;
      } catch (error: unknown) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      let stat: fs.Stats | undefined;
      try { stat = fs.lstatSync(snapshotPath); }
      catch (error: unknown) {
        if (!isRecord(error) || error.code !== "ENOENT") throw error;
      }
      if (stat) {
        if (!safeOwned(stat, false) || stat.size > MAX_SNAPSHOT_BYTES || stat.nlink !== 1) throw new RunnerStateError("state_unavailable");
        this.snapshot = decodeSnapshot(JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as unknown, options.ownerId);
      } else if (initialized) throw new RunnerStateError("state_unavailable");
      const now = Date.now();
      // Every startup invalidates stale clients. Never restore armed authority: a live_armed agent restarts
      // live_unarmed, so arming again needs the owner's CLI, typed confirmation and passphrase in this daemon run.
      this.snapshot.agents = this.snapshot.agents.map((agent) => {
        const next: RunnerAgentState = { ...agent, version: this.nextVersion(agent.version), updatedAt: now };
        if (next.mode === "live_armed") { next.mode = "live_unarmed"; next.armed = false; delete next.entries; }
        return next;
      });
      for (const agentId of options.agentIds) {
        if (!this.snapshot.agents.some((agent) => agent.agentId === agentId)) {
          this.snapshot.agents.push({ agentId, version: 1, mode: "shadow", lifecycle: "idle", armed: false, execution: "unavailable", updatedAt: now });
        }
      }
      if (this.snapshot.agents.length > MAX_AGENTS) throw new RunnerStateError("invalid_options");
      this.persist(this.snapshot);
      if (!initialized) {
        const descriptor = fs.openSync(markerPath, "wx", 0o600);
        try { fs.writeFileSync(descriptor, "1\n"); fs.fsyncSync(descriptor); }
        finally { fs.closeSync(descriptor); }
        this.syncDirectory();
      }
    } catch {
      this.close();
      throw new RunnerStateError("state_unavailable");
    } finally { gate?.close(); }
  }

  control(input: RunnerRequest): RunnerResponse {
    const request = parseRequest(input);
    if (!this.isAvailable()) return failure(request.id, "state_unavailable");
    const current = this.snapshot.agents.find((agent) => agent.agentId === request.agentId);
    if (!current) return failure(request.id, "unknown_agent");
    if (request.action === "status") return { version: 1, id: request.id, ok: true, state: copy(current) };
    const previous = this.snapshot.receipts.find((receipt) => receipt.request.id === request.id);
    if (previous) {
      return previous.request.agentId === request.agentId && previous.request.action === request.action
        && previous.request.expectedVersion === request.expectedVersion
        ? copy(previous.response) : failure(request.id, "id_conflict", current);
    }
    const next = copy(this.snapshot);
    if (!this.room(next, request.action)) return failure(request.id, "journal_full", current);
    const agent = next.agents.find((item) => item.agentId === request.agentId)!;
    let response: RunnerResponse;
    // Disarm and stop are idempotent "ensure" operations: a stale expectedVersion (the state moved on since the caller
    // read it) never refuses them. Already unarmed / already stopped is acknowledged unchanged; otherwise they apply.
    const ensure = (request.action === "disarm" || request.action === "stop") && request.expectedVersion < agent.version;
    // Phase 1 audit M3: pause of an agent that is live_armed NOW is an ensure too ("no new entries"): a stale expectedVersion (an
    // internal change or exits-only hold moved the version since the Hub or CLI read it) never refuses it. It always applies: entries
    // paused (already paused stays paused), version + 1 and a receipt, so a hold's release (CAS on the hold version) then finds the
    // version moved and the owner's pause stands. A stale pause of an agent that is not armed now still conflicts (it would change
    // its mode).
    const ensurePause = request.action === "pause" && agent.mode === "live_armed" && agent.armed === true && agent.lifecycle === "idle"
      && request.expectedVersion < agent.version;
    if (ensure && (request.action === "disarm" ? agent.mode !== "live_armed" : agent.lifecycle === "stopped")) {
      response = { version: 1, id: request.id, ok: true, state: copy(agent) };
    } else if (request.expectedVersion !== agent.version && !ensure && !ensurePause) response = failure(request.id, "version_conflict", agent);
    else if (request.action === "arm") response = failure(request.id, "execution_unavailable", agent);
    else {
      try { agent.version = this.nextVersion(agent.version); }
      catch { this.held = true; return failure(request.id, "state_unavailable"); }
      agent.updatedAt = Date.now();
      if (request.action === "pause" && agent.mode === "live_armed") {
        // Owner pause of an armed agent: no new entries, protective exits continue. It stays live_armed and armed.
        agent.entries = "paused";
      } else {
        if (request.action === "pause") agent.mode = "paused";
        if (request.action === "stop") { agent.mode = "paused"; agent.lifecycle = "stopped"; }
        if (request.action === "resume") { agent.mode = "shadow"; agent.lifecycle = "idle"; }
        // Disarm never resumes a paused or stopped agent: live_armed becomes live_unarmed, every other mode is unchanged.
        if (request.action === "disarm" && agent.mode === "live_armed") agent.mode = "live_unarmed";
        // Every other plain control transition (stop and disarm included: no execution at all, exits included) is unarmed.
        agent.armed = false; delete agent.entries;
      }
      response = { version: 1, id: request.id, ok: true, state: copy(agent) };
    }
    next.receipts.push({ request: copy(request), response: copy(response), recordedAt: Date.now() });
    try {
      this.persist(next);
      this.snapshot = next;
      return response;
    } catch {
      this.held = true;
      return failure(request.id, "state_unavailable");
    }
  }

  /** The only transition into live_armed. Called solely by the daemon's private arming channel after its prechecks,
   * typed confirmation and passphrase verification; the plain `arm` control action stays refused. Same receipt journal
   * and version CAS as every control: shadow or live_unarmed, idle, at exactly expectedVersion. Arms with entries enabled. */
  arm(input: { id: string; agentId: string; expectedVersion: number }): RunnerResponse {
    const request = parseRequest({ version: 1, id: input.id, agentId: input.agentId, action: "arm", expectedVersion: input.expectedVersion });
    if (request.action !== "arm") return failure(request.id, "invalid_request");
    if (!this.isAvailable()) return failure(request.id, "state_unavailable");
    const current = this.snapshot.agents.find((agent) => agent.agentId === request.agentId);
    if (!current) return failure(request.id, "unknown_agent");
    const previous = this.snapshot.receipts.find((receipt) => receipt.request.id === request.id);
    if (previous) {
      return previous.request.agentId === request.agentId && previous.request.action === "arm"
        && previous.request.expectedVersion === request.expectedVersion ? copy(previous.response) : failure(request.id, "id_conflict", current);
    }
    const next = copy(this.snapshot);
    if (!this.room(next, "arm")) return failure(request.id, "journal_full", current);
    const agent = next.agents.find((item) => item.agentId === request.agentId)!;
    let response: RunnerResponse;
    if (request.expectedVersion !== agent.version) response = failure(request.id, "version_conflict", agent);
    else if (agent.lifecycle !== "idle" || (agent.mode !== "shadow" && agent.mode !== "live_unarmed")) response = failure(request.id, "execution_unavailable", agent);
    else {
      try { agent.version = this.nextVersion(agent.version); }
      catch { this.held = true; return failure(request.id, "state_unavailable"); }
      agent.updatedAt = Date.now(); agent.mode = "live_armed"; agent.armed = true; agent.entries = "enabled";
      response = { version: 1, id: request.id, ok: true, state: copy(agent) };
    }
    next.receipts.push({ request: copy(request), response: copy(response), recordedAt: Date.now() });
    try {
      this.persist(next);
      this.snapshot = next;
      return response;
    } catch {
      this.held = true;
      return failure(request.id, "state_unavailable");
    }
  }

  /** Owner decision of 17 Nov 2026: while an owner change to rules, caps or sizing of an ARMED agent is saved, only new entries
   * pause; the agent stays live_armed and armed, so protective exits keep running. Internal only (the daemon's change path):
   * never a control action, never reachable from Hub, the SDK or the backend. live_armed with entries enabled -> entries paused,
   * version + 1, one receipt (recorded as `pause`, the control with exactly this effect on live_armed). Already paused or not
   * armed: nothing is written. */
  holdEntries(agentId: string): RunnerEntriesHold {
    const result = this.entriesTransition(agentId, "paused", undefined);
    switch (result.kind) {
      case "applied": return { kind: "held", state: result.state };
      case "unchanged": return { kind: "already_paused", state: result.state };
      case "refused": return result;
      // No expected version is passed, so version_changed cannot occur; never reported as a hold.
      default: return { kind: "not_armed", state: result.state };
    }
  }

  /** The counterpart of `holdEntries`, after the change was saved: only while still live_armed, entries paused and the version
   * is exactly `expectedVersion` (the version the hold produced). Any control in between moved the version, so an owner pause,
   * disarm, stop or re-arm is never overridden. Entries enabled, version + 1, one receipt (recorded as `arm`, the only control
   * whose result has entries enabled; it never re-arms a disarmed agent). Never `resume`: that disarms. */
  releaseEntries(agentId: string, expectedVersion: number): RunnerEntriesRelease {
    const result = this.entriesTransition(agentId, "enabled", expectedVersion);
    switch (result.kind) {
      case "applied": return { kind: "released", state: result.state };
      case "unchanged": return { kind: "not_paused", state: result.state };
      default: return result;
    }
  }

  isAvailable(): boolean {
    if (this.closed || this.held) return false;
    try { this.writer.assertWriter(this.directory); return true; }
    catch { this.held = true; return false; }
  }

  /** Historical acknowledgement only. Never applies an intent or advances state.
   * Missing is not proof that an interrupted operation was never applied. */
  lookupControlReceipt(input: RunnerRequest): RunnerReceiptLookup {
    const request = parseRequest(input);
    if (request.action === "status") throw new RunnerStateError("invalid_options");
    if (!this.isAvailable()) return { kind: "unavailable" };
    const receipt = this.snapshot.receipts.find((entry) => entry.request.id === request.id);
    if (!receipt) return { kind: "missing" };
    if (receipt.request.agentId !== request.agentId || receipt.request.action !== request.action
      || receipt.request.expectedVersion !== request.expectedVersion) return { kind: "conflict" };
    return { kind: "found", response: copy(receipt.response) };
  }

  agentIds(): string[] | undefined {
    return this.isAvailable() ? this.snapshot.agents.map((agent) => agent.agentId) : undefined;
  }

  /** Owner decision of 19 Nov 2026: adds one agent to this running store (owner-local `register_agent` only; never a control
   * action, so neither Hub nor the control bridge can reach it). The new agent starts shadow, idle and unarmed at version 1; it is
   * persisted in this snapshot, which is what every later start (and `knownRunnerAgents`) reads, so a restart knows it. Every other
   * agent's state, version and entries are untouched and no receipt is written. Already registered: nothing is written (`existing`).
   * A failed write refuses only this registration (the in-memory snapshot is replaced only after a successful rename) and does not
   * hold the store: the other agents' controls and exits keep working. */
  registerAgent(agentId: string): { kind: "added" | "existing"; state: RunnerAgentState }
    | { kind: "refused"; error: "invalid_request" | "agent_limit" | "state_unavailable" } {
    if (!isId(agentId)) return { kind: "refused", error: "invalid_request" };
    if (!this.isAvailable()) return { kind: "refused", error: "state_unavailable" };
    const current = this.snapshot.agents.find((agent) => agent.agentId === agentId);
    if (current) return { kind: "existing", state: copy(current) };
    if (this.snapshot.agents.length >= MAX_AGENTS) return { kind: "refused", error: "agent_limit" };
    const next = copy(this.snapshot);
    const agent: RunnerAgentState = { agentId, version: 1, mode: "shadow", lifecycle: "idle", armed: false, execution: "unavailable", updatedAt: Date.now() };
    next.agents.push(agent);
    try { this.persist(next); }
    catch { return { kind: "refused", error: "state_unavailable" }; }
    this.snapshot = next;
    return { kind: "added", state: copy(agent) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.ownsWriter) this.writer.close();
  }

  /** Prunes expired receipts in `next`, then decides whether this action may add one. Disarm and stop always can. */
  private room(next: Snapshot, action: Exclude<RunnerRequest, { action: "status" }>["action"]): boolean {
    const cutoff = Date.now() - RUNNER_RECEIPT_RETENTION_MS;
    next.receipts = next.receipts.filter((receipt) => receipt.recordedAt >= cutoff);
    if (action === "disarm" || action === "stop") {
      if (next.receipts.length >= MAX_RECEIPTS) next.receipts = [...next.receipts].sort((a, b) => a.recordedAt - b.recordedAt).slice(next.receipts.length - MAX_RECEIPTS + 1);
      return true;
    }
    const limit = MAX_RECEIPTS - RUNNER_RECEIPT_SAFETY_RESERVE - (action === "arm" ? RUNNER_RECEIPT_ARM_FREE : 0);
    return next.receipts.length < limit;
  }

  /** Shared by holdEntries/releaseEntries: same receipt journal, persist and version rules as `arm`. Both use the ordinary
   * receipt quota (like pause), never the stricter arming one. Receipts use existing control actions, so the snapshot format is
   * unchanged and an older runner still reads it. */
  private entriesTransition(agentId: string, entries: RunnerAgentEntries, expectedVersion: number | undefined): EntriesTransition {
    if (!isId(agentId)) return { kind: "refused", error: "unknown_agent" };
    if (!this.isAvailable()) return { kind: "refused", error: "state_unavailable" };
    const current = this.snapshot.agents.find((agent) => agent.agentId === agentId);
    if (!current) return { kind: "refused", error: "unknown_agent" };
    if (current.mode !== "live_armed" || current.armed !== true || current.lifecycle !== "idle") return { kind: "not_armed", state: copy(current) };
    if (expectedVersion !== undefined && current.version !== expectedVersion) return { kind: "version_changed", state: copy(current) };
    if (current.entries === entries) return { kind: "unchanged", state: copy(current) };
    const next = copy(this.snapshot);
    if (!this.room(next, "pause")) return { kind: "refused", error: "journal_full" };
    const agent = next.agents.find((item) => item.agentId === agentId)!;
    const request: Exclude<RunnerRequest, { action: "status" }> = { version: 1, id: randomUUID(), agentId,
      action: entries === "paused" ? "pause" : "arm", expectedVersion: agent.version };
    try { agent.version = this.nextVersion(agent.version); }
    catch { this.held = true; return { kind: "refused", error: "state_unavailable" }; }
    agent.updatedAt = Date.now(); agent.entries = entries;
    const response: RunnerResponse = { version: 1, id: request.id, ok: true, state: copy(agent) };
    next.receipts.push({ request, response: copy(response), recordedAt: Date.now() });
    try {
      this.persist(next);
      this.snapshot = next;
      return { kind: "applied", state: copy(agent) };
    } catch {
      this.held = true;
      return { kind: "refused", error: "state_unavailable" };
    }
  }

  private nextVersion(version: number): number {
    if (!Number.isSafeInteger(version + 1)) throw new RunnerStateError("state_unavailable");
    return version + 1;
  }

  private persist(snapshot: Snapshot): void {
    this.writer.assertWriter(this.directory);
    const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
    if (bytes.length > MAX_SNAPSHOT_BYTES) throw new RunnerStateError("state_unavailable");
    const temporary = path.join(this.directory, `.control-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, bytes);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      this.writer.assertWriter(this.directory);
      fs.renameSync(temporary, path.join(this.directory, SNAPSHOT_FILE));
      this.syncDirectory();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch { /* Only this write's temporary file. */ }
    }
  }

  private syncDirectory(): void {
    this.writer.syncDirectory();
  }
}
