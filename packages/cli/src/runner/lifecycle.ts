import type { RunnerBrainObservation, RunnerKeystoreObservation } from "@balchemyai/agent-sdk";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { requestRunner, RunnerTransportError } from "./client.js";
import { requireUnixPlatform, SOCKET_FILE } from "./daemon.js";
import { LOCK_DIRECTORY, requirePrivateDirectory } from "./state.js";
import { GATE_FILE, WALLET_LOCK, WRITER_FILE, RunnerKernelLock, RunnerLockError, inspectKernelFile, privateOwned, sameIdentity } from "./kernel-lock.js";
import { decisionOutboxFiles } from "./private-decision-outbox.js";
import { privateExecutionIntentFiles } from "./private-execution-intents.js";
import { privateDcaStoreFiles } from "./private-dca-store.js";
import { PRIVATE_BRAIN_INITIALIZED_FILE, PRIVATE_BRAIN_SNAPSHOT_FILE } from "./private-brain-store.js";
import { PRIVATE_INTENT_FILE, PRIVATE_INTENT_MARKER } from "./private-intent-service.js";
import { PRIVATE_MODEL_VAULT_FILE, PRIVATE_MODEL_VAULT_MARKER } from "./private-model-vault.js";
import { privateOwnerApprovalFiles } from "./private-owner-approvals.js";
import { privateOwnerPinFiles } from "./private-owner-pin.js";
import { privateAuthoritySealFiles } from "./private-authority-seal.js";
import { privatePositionFiles } from "./private-positions.js";
import { PRIVATE_RULE_INITIALIZED_FILE, PRIVATE_RULE_SNAPSHOT_FILE } from "./private-rule-store.js";
import { privateSolanaRpcFiles } from "./private-solana-rpc-settings.js";
import { privateSpendFiles } from "./private-spend-ledger.js";
import { privateSubmissionFiles } from "./private-submission-journal.js";
import { tradingBindingFiles } from "./private-trading-binding.js";
import { tradingWalletFiles } from "./private-trading-keystore.js";
import { BRAIN_ARCHIVE_PREFIX, WORKING_ARCHIVE_PREFIX } from "./private-working-archive.js";
import { PRIVATE_WORKING_SET_FILE, PRIVATE_WORKING_SET_MARKER } from "./private-working-set.js";
import { exactKeys, isId, isRecord, type RunnerAgentState, type RunnerResponse, type RunnerHubStatus, type RunnerSubmissionSecurity, type RunnerExecutionStatus } from "./protocol.js";
import {
  acquireLauncherLock, DAEMON_FILE, exists, inspectDirectory, PROFILE_FILE, readDaemonMetadata,
  readLocalProfile, RunnerLifecycleError, START_LOCK, writeMetadata, type DaemonMetadata, type LocalProfile,
} from "./metadata.js";

export type RunnerCommand = "start" | "add" | "status" | "stop" | "disarm" | "shutdown" | "recover";
type InspectedRunnerAgent = RunnerAgentState & { hub?: RunnerHubStatus; brainObservation?: RunnerBrainObservation; keystoreObservation?: RunnerKeystoreObservation;
  submissionSecurity?: RunnerSubmissionSecurity;
  executionStatus?: RunnerExecutionStatus };
export interface RunnerStatus {
  process: "running" | "stopped";
  pairing: "unpaired";
  brain: "not_attached";
  execution: "unavailable";
  /** True when any inspected agent reports live_armed (owner CLI arming); the daemon itself is never armed. */
  armed: boolean;
  agents: InspectedRunnerAgent[];
}
interface Context { directory: string; profile?: LocalProfile; metadata?: DaemonMetadata }

export function runnerDirectory(): string { return path.join(os.homedir(), ".balchemy", "runner"); }
export function validateRunnerArguments(action: string, args: string[]): asserts action is RunnerCommand {
  if (!["start", "add", "status", "stop", "disarm", "shutdown", "recover"].includes(action) || args.some((id) => !isId(id))
    || (action === "start" && (args.length === 0 || args.length > 64 || new Set(args).size !== args.length))
    || ((action === "stop" || action === "disarm" || action === "add") && args.length !== 1) || (action === "status" && args.length > 1)
    || ((action === "shutdown" || action === "recover") && args.length !== 0)) throw new RunnerLifecycleError("invalid_arguments");
}

function status(processState: "running" | "stopped", agents: InspectedRunnerAgent[] = []): RunnerStatus {
  return { process: processState, pairing: "unpaired", brain: "not_attached", execution: "unavailable", armed: agents.some((agent) => agent.armed), agents };
}

/** What remains of a daemon besides its metadata: nothing, only a writer lock another holder still has, or anything else
 * (the socket, a legacy lock directory). */
function daemonArtifacts(directory: string): "none" | "writer_busy" | "other" {
  if (exists(path.join(directory, SOCKET_FILE))) return "other";
  if (!exists(path.join(directory, LOCK_DIRECTORY))) return "none";
  // Legacy lock directories still require recovery outside this protocol.
  if (fs.lstatSync(path.join(directory, LOCK_DIRECTORY)).isDirectory()) return "other";
  let writer: RunnerKernelLock | undefined;
  try { writer = RunnerKernelLock.acquire(directory, WRITER_FILE); return "none"; }
  catch (error: unknown) { if (error instanceof RunnerLockError && error.code === "lock_busy") return "writer_busy"; throw error; }
  finally { writer?.close(); }
}
function hasDaemonArtifacts(directory: string): boolean { return daemonArtifacts(directory) !== "none"; }

function inspectContext(input: string, allowLauncherLock = false): Context {
  const directory = inspectDirectory(input);
  if (!directory) return { directory: path.resolve(input) };
  if (exists(path.join(directory, START_LOCK))) {
    if (!allowLauncherLock) {
      let gate: RunnerKernelLock | undefined;
      try { gate = RunnerKernelLock.acquire(directory, GATE_FILE); }
      catch { throw new RunnerLifecycleError("recovery_required"); }
      finally { gate?.close(); }
    } else inspectKernelFile(directory, GATE_FILE);
  }
  const profile = readLocalProfile(directory);
  if (!profile) {
    if (fs.readdirSync(directory).some((name) => name !== START_LOCK && name !== WRITER_FILE)
      || hasDaemonArtifacts(directory)) throw new RunnerLifecycleError("recovery_required");
    return { directory };
  }
  const metadata = readDaemonMetadata(directory, profile);
  if (!metadata && hasDaemonArtifacts(directory)) throw new RunnerLifecycleError("recovery_required");
  return { directory, profile, metadata };
}

async function verifyRunning(context: Context): Promise<void> {
  if (!context.metadata) throw new RunnerLifecycleError("not_running");
  try {
    const result = await requestRunner(path.join(context.directory, SOCKET_FILE), {
      version: 1, id: randomUUID(), action: "daemon_status", instanceId: context.metadata.instanceId,
    });
    if (!result.ok || result.daemon?.process !== "running") throw new RunnerLifecycleError("recovery_required");
  } catch { throw new RunnerLifecycleError("recovery_required"); }
}

async function agentStatus(context: Context, agentId: string): Promise<InspectedRunnerAgent> {
  const result = await requestRunner(path.join(context.directory, SOCKET_FILE), { version: 1, id: randomUUID(), action: "status", agentId });
  if (result.error === "unknown_agent") throw new RunnerLifecycleError("agent_not_registered");
  if (!result.ok || !result.state) throw new RunnerLifecycleError("control_rejected");
  return { ...result.state, ...(result.hub ? { hub: result.hub } : {}),
    ...(result.brainObservation ? { brainObservation: result.brainObservation } : {}),
    ...(result.keystoreObservation ? { keystoreObservation: result.keystoreObservation } : {}),
    ...(result.submissionSecurity ? { submissionSecurity: result.submissionSecurity } : {}),
    ...(result.executionStatus ? { executionStatus: result.executionStatus } : {}) };
}

function mutationState(result: RunnerResponse, operationId: string, previous: RunnerAgentState, action: "resume" | "stop"): RunnerAgentState {
  // A failed fsync can follow a successful rename. Preserve the receipt ID:
  // neither that response nor an inconsistent acknowledgement proves rejection.
  // Stop is an idempotent ensure-stopped (a state that moved on since our read is still stopped, not refused).
  if (result.error === "state_unavailable" || (result.ok && (!result.state
    || result.state.agentId !== previous.agentId
    || (action === "stop" ? result.state.version <= previous.version || result.state.armed : result.state.version !== previous.version + 1)
    || result.state.mode !== (action === "resume" ? "shadow" : "paused")
    || result.state.lifecycle !== (action === "resume" ? "idle" : "stopped")))) {
    throw new RunnerTransportError("outcome_unknown", operationId);
  }
  if (!result.ok || !result.state) throw new RunnerLifecycleError("control_rejected");
  return result.state;
}

/** Node flags for the daemon, which may hold unlocked trading keys. `--disable-sigusr1`
 * (Node 22.14+, 23.7+, 24+) stops any same-user SIGUSR1 from opening the inspector in it.
 * Older Node releases allowed by `engines` reject the flag, so they start without it.
 * Node has no setrlimit or prctl: core dumps cannot be disabled from here; the daemon
 * inherits the launcher's limits (README: run `ulimit -c 0` before `runner start`). */
export function daemonExecArgv(version: string = process.versions.node): string[] {
  const [major = Number.NaN, minor = Number.NaN] = version.split(".").map((part) => Number.parseInt(part, 10));
  const supported = major >= 24 || (major === 23 && minor >= 7) || (major === 22 && minor >= 14);
  return supported ? ["--disable-sigusr1"] : [];
}

async function launch(context: Context, agentIds: string[], writer: RunnerKernelLock): Promise<void> {
  const profile = context.profile;
  if (!profile) throw new RunnerLifecycleError("metadata_invalid");
  const instanceId = randomUUID();
  // No parent environment, Node options, credentials, inherited cwd or terminal.
  writer.assertWriter(context.directory);
  const child = spawn(process.execPath, [...daemonExecArgv(), fileURLToPath(new URL("./host.js", import.meta.url))], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc", writer.fd], env: {}, cwd: context.directory,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.off("exit", onExit);
        child.off("message", onMessage);
        if (error) reject(error); else resolve();
      };
      const onError = (): void => finish(new RunnerLifecycleError("start_failed"));
      const onExit = (): void => finish(new RunnerLifecycleError("start_failed"));
      const onMessage = (value: unknown): void => {
        if (!isRecord(value) || !exactKeys(value, ["ready", "instanceId", "pid"]) || value.ready !== true
          || value.instanceId !== instanceId || value.pid !== child.pid) { onError(); return; }
        try {
          const persisted = readDaemonMetadata(context.directory, profile);
          if (!persisted || persisted.instanceId !== instanceId || persisted.pid !== child.pid) { onError(); return; }
          context.metadata = persisted;
          finish();
        } catch { onError(); }
      };
      const timer = setTimeout(onError, 5_000);
      child.once("error", onError);
      child.once("exit", onExit);
      child.once("message", onMessage);
      child.send({ directory: context.directory, localProfileId: profile.localProfileId, instanceId, agentIds }, (error) => { if (error) onError(); });
    });
  } catch {
    // This is our just-spawned ChildProcess, never a PID read from disk.
    child.kill("SIGTERM");
    throw new RunnerLifecycleError("start_failed");
  } finally {
    if (child.connected) child.disconnect();
    child.unref();
  }
}

/** The running daemon's package version, or null when no daemon runs, it predates `daemon_version` (0.4.x) or the read fails. */
export async function readRunnerVersion(directory: string = runnerDirectory()): Promise<string | null> {
  try {
    const context = inspectContext(directory);
    if (!context.metadata) return null;
    const result = await requestRunner(path.join(context.directory, SOCKET_FILE), {
      version: 1, id: randomUUID(), action: "daemon_version", instanceId: context.metadata.instanceId,
    });
    return result.ok && typeof result.daemon?.packageVersion === "string" ? result.daemon.packageVersion : null;
  } catch { return null; }
}

/** `resume: false` (a bare `runner start`) registers the agents without resuming one the owner stopped or paused. */
export async function startLocalRunner(directory: string, agentIds: string[], options: { resume?: boolean } = {}): Promise<RunnerStatus> {
  requireUnixPlatform();
  validateRunnerArguments("start", agentIds);
  const privateDirectory = requirePrivateDirectory(directory);
  const release = acquireLauncherLock(privateDirectory);
  try {
    const context = inspectContext(privateDirectory, true);
    if (!context.metadata) {
      const writer = RunnerKernelLock.acquire(privateDirectory, WRITER_FILE);
      try {
        if (!context.profile) {
          context.profile = { schemaVersion: 1, localProfileId: `local-${randomUUID()}`, pairing: "unpaired" };
          writeMetadata(context.directory, PROFILE_FILE, context.profile, writer);
        }
        await launch(context, agentIds, writer);
      } finally { writer.close(); }
    }
    await verifyRunning(context);
    // Verify every requested agent before applying any resume command. Owner decision of 19 Nov 2026: an agent the RUNNING runner does
    // not know yet is registered with it (shadow, unarmed) instead of refused; no other agent is restarted, disarmed or changed.
    const agents: InspectedRunnerAgent[] = [];
    for (const agentId of agentIds) {
      try { agents.push(await agentStatus(context, agentId)); }
      catch (error: unknown) {
        if (!(error instanceof RunnerLifecycleError && error.code === "agent_not_registered")) throw error;
        await registerRunningAgent(context, agentId);
        agents.push(await agentStatus(context, agentId));
      }
    }
    const resumed: InspectedRunnerAgent[] = [];
    for (const agent of agents) {
      if (options.resume !== false && (agent.lifecycle === "stopped" || agent.mode === "paused")) {
        const operationId = randomUUID();
        const result = await requestRunner(path.join(context.directory, SOCKET_FILE), {
          version: 1, id: operationId, action: "resume", agentId: agent.agentId, expectedVersion: agent.version,
        });
        resumed.push(mutationState(result, operationId, agent, "resume"));
      } else resumed.push(agent);
    }
    return status("running", resumed);
  } finally { release(); }
}

/** One `register_agent` on the running daemon (owner socket). "added" must be the new shadow, idle, unarmed agent; "existing" is the
 * already registered one, unchanged. A failed write or an incomplete extension (state_unavailable) is an unknown outcome: the
 * registration is idempotent, so the owner checks `runner status` or runs it again. An older runner rejects the request. */
async function registerRunningAgent(context: Context, agentId: string): Promise<RunnerAgentState> {
  if (!context.metadata) throw new RunnerLifecycleError("not_running");
  const socketPath = path.join(context.directory, SOCKET_FILE);
  const operationId = randomUUID();
  let result: RunnerResponse;
  try {
    result = await requestRunner(socketPath, { version: 1, id: operationId, action: "register_agent", instanceId: context.metadata.instanceId, agentId });
  } catch (error: unknown) {
    // A runner older than this request answers it with an id-less invalid_request, which the client reads as an unknown outcome
    // (as it does a reply lost in transit). One status read settles it: a known agent is registered (the request is idempotent);
    // an unknown one was not added, so the older runner rejected it (control_rejected names the restart). Nothing is retried.
    if (!(error instanceof RunnerTransportError && error.code === "outcome_unknown")) throw error;
    const check = await requestRunner(socketPath, { version: 1, id: randomUUID(), action: "status", agentId });
    if (check.ok && check.state?.agentId === agentId) return check.state;
    if (check.error === "unknown_agent") throw new RunnerLifecycleError("control_rejected");
    throw error;
  }
  if (result.error === "agent_limit") throw new RunnerLifecycleError("agent_limit");
  if (result.error === "state_unavailable" || (result.ok && (!result.state || result.state.agentId !== agentId || !result.registration
    || (result.registration === "added" && (result.state.mode !== "shadow" || result.state.lifecycle !== "idle" || result.state.armed
      || result.state.version !== 1))))) throw new RunnerTransportError("outcome_unknown", operationId);
  if (!result.ok || !result.state) throw new RunnerLifecycleError("control_rejected");
  return result.state;
}

/** Owner decision of 19 Nov 2026: `runner add <agent-id>` adds an agent to the RUNNING runner, without a restart, so every other agent
 * stays armed (or as it is) with its positions protected. The new agent starts in shadow mode, unarmed; pair and set it up next.
 * Already registered: nothing changes. The runner must be running (otherwise: `runner start <agent-id>`). Removal is not supported. */
export async function registerLocalAgent(directory: string, agentId: string): Promise<RunnerStatus> {
  requireUnixPlatform();
  validateRunnerArguments("add", [agentId]);
  const context = inspectContext(directory);
  await verifyRunning(context);
  await registerRunningAgent(context, agentId);
  return status("running", [await agentStatus(context, agentId)]);
}

export async function inspectLocalRunner(directory: string, agentId?: string): Promise<RunnerStatus> {
  requireUnixPlatform();
  validateRunnerArguments("status", agentId === undefined ? [] : [agentId]);
  const context = inspectContext(directory);
  if (!context.metadata) return status("stopped");
  await verifyRunning(context);
  let ids: string[];
  if (agentId !== undefined) ids = [agentId];
  else {
    const result = await requestRunner(path.join(context.directory, SOCKET_FILE), {
      version: 1, id: randomUUID(), action: "agent_list", instanceId: context.metadata.instanceId,
    });
    if (!result.ok || !result.inventory) throw new RunnerLifecycleError("control_rejected");
    ids = result.inventory.agentIds;
  }
  const agents: InspectedRunnerAgent[] = [];
  for (const id of ids) agents.push(await agentStatus(context, id));
  return status("running", agents);
}

export async function stopLocalAgent(directory: string, agentId: string): Promise<RunnerStatus> {
  requireUnixPlatform();
  validateRunnerArguments("stop", [agentId]);
  const context = inspectContext(directory);
  await verifyRunning(context);
  const agent = await agentStatus(context, agentId);
  const operationId = randomUUID();
  const result = await requestRunner(path.join(context.directory, SOCKET_FILE), {
    version: 1, id: operationId, action: "stop", agentId, expectedVersion: agent.version,
  });
  return status("running", [mutationState(result, operationId, agent, "stop")]);
}

/** `runner disarm <agent>`: immediate, no passphrase. live_armed becomes live_unarmed (no execution at all, exits included);
 * every other mode is unchanged. Same durable receipt journal as every control, but an idempotent ensure-unarmed: a state
 * that moved on since the read (stale version) is disarmed anyway, never refused with version_conflict. */
export async function disarmLocalAgent(directory: string, agentId: string): Promise<RunnerStatus> {
  requireUnixPlatform();
  validateRunnerArguments("disarm", [agentId]);
  const context = inspectContext(directory);
  await verifyRunning(context);
  const agent = await agentStatus(context, agentId);
  const operationId = randomUUID();
  const result = await requestRunner(path.join(context.directory, SOCKET_FILE), {
    version: 1, id: operationId, action: "disarm", agentId, expectedVersion: agent.version,
  });
  const expectedMode = agent.mode === "live_armed" ? "live_unarmed" : agent.mode;
  const exact = result.state?.version === agent.version + 1;
  if (result.error === "state_unavailable" || (result.ok && (!result.state || result.state.agentId !== agent.agentId
    || result.state.version <= agent.version || result.state.armed || result.state.mode === "live_armed"
    || (exact && (result.state.mode !== expectedMode || result.state.lifecycle !== agent.lifecycle))))) throw new RunnerTransportError("outcome_unknown", operationId);
  if (!result.ok || !result.state) throw new RunnerLifecycleError("control_rejected");
  return status("running", [result.state]);
}

const TEMPORARY_COORDINATION = /^\.(?:metadata|control)-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/;
const PAIRING_ARTIFACT = /^pairing-[0-9a-f]{64}(?:\.(?:approval|adoption))?\.(?:json|initialized)$/;

/** SF7 (M3.6 D6, finding F-M36-D6-SF7): the runner's own data files, so `runner recover` accepts a configured folder. Each name comes from
 * the code that creates it (the stores' own file-name functions and constants); no wildcard. Recovery only ACCEPTS these: it never opens,
 * reads, moves or deletes one (it removes only the stale socket, daemon metadata and coordination temporaries, as before). Any other
 * name, any directory (a legacy lock directory, a pairing identity lock left by a crash) or a non-private file still refuses.
 * - Per-agent stores named by sha256(agentId) (journal, spend ledger, positions, keystore, wallet binding, RPC, owner approvals, decision
 *   outbox, execution intents, DCA records, and A2a's owner pin and authority seal): snapshot, marker, and the temporary an interrupted commit leaves (owned-json-snapshot.ts,
 *   `.<snapshot>-<uuid>.tmp`). The agent hash is the only variable part, found by naming a probe agent with the store's own function.
 * - Fixed-name stores (rules, brain jobs, research working set, intent previews; the model vault and its `.private-model-<uuid>.tmp`).
 * - Archive segments (private-working-archive.ts: `<prefix><endSequence>-<sha256>.json|.mark`, and their commit temporaries).
 * - Wallet locks (kernel-lock.ts walletLockFile), empty private files like the gate and writer locks. */
const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const HEX64_PATTERN = "[0-9a-f]{64}";
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
let runnerDataNames: readonly RegExp[] | undefined;
function runnerData(): readonly RegExp[] {
  if (runnerDataNames) return runnerDataNames;
  const probe = "recovery-inventory-probe";
  const hash = createHash("sha256").update(probe, "utf8").digest("hex");
  const exact = (name: string): RegExp => new RegExp(`^${literal(name)}$`);
  const temporary = (snapshot: string): RegExp => new RegExp(`^\\.${snapshot}-${UUID_PATTERN}\\.tmp$`);
  const names: RegExp[] = [];
  for (const files of [privateSubmissionFiles, privateSpendFiles, privatePositionFiles, tradingWalletFiles, tradingBindingFiles, privateSolanaRpcFiles,
    privateOwnerApprovalFiles, decisionOutboxFiles, privateExecutionIntentFiles, privateDcaStoreFiles, privateOwnerPinFiles, privateAuthoritySealFiles]) {
    const { snapshotFile, markerFile } = files(probe);
    // The agent hash must appear exactly once in each name; anything else is a naming change this inventory does not know (fail closed).
    const agent = (name: string): string => {
      if (name.split(hash).length !== 2) throw new RunnerLifecycleError("recovery_required");
      return literal(name).replace(hash, HEX64_PATTERN);
    };
    names.push(new RegExp(`^${agent(snapshotFile)}$`), new RegExp(`^${agent(markerFile)}$`), temporary(agent(snapshotFile)));
  }
  for (const [snapshot, marker] of [[PRIVATE_RULE_SNAPSHOT_FILE, PRIVATE_RULE_INITIALIZED_FILE], [PRIVATE_BRAIN_SNAPSHOT_FILE, PRIVATE_BRAIN_INITIALIZED_FILE],
    [PRIVATE_WORKING_SET_FILE, PRIVATE_WORKING_SET_MARKER], [PRIVATE_INTENT_FILE, PRIVATE_INTENT_MARKER]] as const) {
    names.push(exact(snapshot), exact(marker), temporary(literal(snapshot)));
  }
  names.push(exact(PRIVATE_MODEL_VAULT_FILE), exact(PRIVATE_MODEL_VAULT_MARKER), new RegExp(`^\\.private-model-${UUID_PATTERN}\\.tmp$`));
  for (const prefix of [WORKING_ARCHIVE_PREFIX, BRAIN_ARCHIVE_PREFIX]) {
    const segment = `${literal(prefix)}[1-9][0-9]{0,15}-${HEX64_PATTERN}`;
    names.push(new RegExp(`^${segment}\\.(?:json|mark)$`), temporary(`${segment}\\.json`));
  }
  names.push(WALLET_LOCK);
  runnerDataNames = Object.freeze(names);
  return runnerDataNames;
}

function recoveryInventory(directory: string): Map<string, fs.Stats> {
  const result = new Map<string, fs.Stats>();
  const data = runnerData();
  for (const name of fs.readdirSync(directory)) {
    const stat = fs.lstatSync(path.join(directory, name));
    const known = [GATE_FILE, WRITER_FILE, PROFILE_FILE, DAEMON_FILE, "control-state.json", "control.initialized", SOCKET_FILE].includes(name)
      || TEMPORARY_COORDINATION.test(name) || PAIRING_ARTIFACT.test(name) || data.some((pattern) => pattern.test(name));
    if (!known || !privateOwned(stat, name === SOCKET_FILE ? "socket" : "file")) throw new RunnerLifecycleError("recovery_required");
    result.set(name, stat);
  }
  return result;
}

function unchangedInventory(directory: string, saved: Map<string, fs.Stats>): void {
  const current = recoveryInventory(directory);
  if (current.size !== saved.size) throw new RunnerLifecycleError("recovery_required");
  for (const [name, old] of saved) {
    const now = current.get(name);
    if (!now || !sameIdentity(old, now) || now.size !== old.size || now.mtimeMs !== old.mtimeMs || now.ctimeMs !== old.ctimeMs) {
      throw new RunnerLifecycleError("recovery_required");
    }
  }
}

/** Any accepting listener, including one that never replies, prevents recovery. */
async function requireRefusedSocket(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (stale: boolean): void => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (stale) resolve(); else reject(new RunnerLifecycleError("recovery_required"));
    };
    const timer = setTimeout(() => finish(false), 1000);
    socket.once("connect", () => finish(false));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(error.code === "ECONNREFUSED"));
  });
}

/** Proves exclusive ownership in the kernel, then removes only coordination.
 * Does not load private identities, open the state store, resume or spawn. */
export async function recoverLocalRunner(input: string): Promise<RunnerStatus> {
  requireUnixPlatform();
  const directory = inspectDirectory(input);
  if (!directory) return status("stopped");
  const prior = fs.readdirSync(directory);
  // Existing data without both new lock identities cannot prove participation.
  const gateExists = inspectKernelFile(directory, GATE_FILE);
  const writerExists = inspectKernelFile(directory, WRITER_FILE);
  if (prior.some((name) => name !== GATE_FILE && name !== WRITER_FILE) && (!gateExists || !writerExists)) {
    throw new RunnerLifecycleError("recovery_required");
  }
  const gate = RunnerKernelLock.acquire(directory, GATE_FILE);
  let writer: RunnerKernelLock | undefined;
  try {
    writer = RunnerKernelLock.acquire(directory, WRITER_FILE);
    const artifacts = recoveryInventory(directory);
    const profile = readLocalProfile(directory);
    if (!profile && [...artifacts.keys()].some((name) => name !== GATE_FILE && name !== WRITER_FILE && !TEMPORARY_COORDINATION.test(name))) {
      throw new RunnerLifecycleError("recovery_required");
    }
    const metadata = profile ? readDaemonMetadata(directory, profile) : undefined;
    if (metadata && metadata.schemaVersion !== 2) throw new RunnerLifecycleError("recovery_required");
    if (artifacts.has(SOCKET_FILE)) await requireRefusedSocket(path.join(directory, SOCKET_FILE));
    gate.assertValid(); writer.assertWriter(directory);
    unchangedInventory(directory, artifacts);
    const removable = [...artifacts.keys()].filter((name) => name === SOCKET_FILE || name === DAEMON_FILE || TEMPORARY_COORDINATION.test(name));
    for (const name of removable) {
      gate.assertValid(); writer.assertWriter(directory);
      unchangedInventory(directory, artifacts);
      fs.unlinkSync(path.join(directory, name));
      artifacts.delete(name);
      writer.syncDirectory();
    }
    writer.syncDirectory();
    return status("stopped");
  } finally { writer?.close(); gate.close(); }
}

/** Phase 1 (17 Nov 2026): what a shutdown would leave unprotected, read without unlocking or changing anything (status and the
 * private_positions `list` readback). Positions counts the non-closed ones (open, exit pending, held) among those the readback shows;
 * `atLeast` when it shows only part of them. An agent whose positions could not be read is in `unreadable` and counts as exposed.
 * Null (ungated) only when the runner's metadata shows no runner is running. Phase 1 audit M4: a runner whose metadata exists but whose
 * state cannot be read (it does not answer, a held control journal, an agent list or status that fails) may still be protecting
 * positions, so it counts as exposed (`runner: "unreadable"`): an interactive owner may still type SHUTDOWN, a script is refused.
 * Metadata that cannot be read at all (corrupt or foreign) throws the same error shutdown itself would (nothing is stopped then). */
export interface RunnerShutdownExposure {
  armed: string[]; positions: Array<{ agentId: string; open: number; atLeast: boolean }>; unreadable: string[];
  /** Audit M4: present when the runner's metadata shows one running but its state could not be read. */
  runner?: "unreadable";
}
export async function readRunnerShutdownExposure(directory: string): Promise<RunnerShutdownExposure | null> {
  requireUnixPlatform();
  if (!inspectContext(directory).metadata) return null;
  let current: RunnerStatus;
  try { current = await inspectLocalRunner(directory); } catch { return { armed: [], positions: [], unreadable: [], runner: "unreadable" }; }
  if (current.process !== "running") return null;
  const { readPrivateBrainTarget } = await import("./private-brain-client.js");
  const { parsePrivatePositionRequest, privatePositionBinding, requestPrivatePositions, validatePrivatePositionReply } = await import("./private-position-protocol.js");
  const exposure: RunnerShutdownExposure = { armed: current.agents.filter((agent) => agent.armed).map((agent) => agent.agentId), positions: [], unreadable: [] };
  for (const agent of current.agents) {
    try {
      const target = readPrivateBrainTarget(directory, agent.agentId);
      const request = parsePrivatePositionRequest({ ...privatePositionBinding(target), action: "list" });
      const response = validatePrivatePositionReply(request, await requestPrivatePositions(target.socketPath, request));
      if (!response.ok || response.data.kind !== "list") throw new Error("positions unavailable");
      const readback = response.data.readback;
      // Without automatic exits (the exits-off rollback build) nothing is protected by the runner, so a shutdown changes nothing.
      if (readback.exits !== "available") continue;
      const open = readback.positions.filter((item) => item.state !== "closed").length;
      if (open > 0) exposure.positions.push({ agentId: agent.agentId, open, atLeast: readback.total > readback.positions.length && open === readback.positions.length });
    } catch { exposure.unreadable.push(agent.agentId); }
  }
  return exposure;
}
export function runnerShutdownExposed(exposure: RunnerShutdownExposure | null): exposure is RunnerShutdownExposure {
  return exposure !== null && (exposure.armed.length > 0 || exposure.positions.length > 0 || exposure.unreadable.length > 0
    || exposure.runner === "unreadable");
}
/** The owner warning before a shutdown that leaves positions without stop-loss and take-profit. */
export function formatRunnerShutdownWarning(exposure: RunnerShutdownExposure): string {
  if (exposure.runner === "unreadable") {
    return ["Warning: the runner is running, but its state could not be read, so it may be protecting open positions (counted as exposed).",
      "Stop-loss and take-profit stop while the runner is off, and stay off after it starts again until you arm each agent again "
      + "(balchemy runner arm <agent-id>, or balchemy: it asks your passphrase once). Check first: balchemy runner status"].join("\n");
  }
  const lines = ["Warning: the runner is protecting open positions."];
  if (exposure.armed.length > 0) lines.push(`Armed now: ${exposure.armed.join(", ")}.`);
  for (const item of exposure.positions) lines.push(`${item.agentId}: ${item.atLeast ? "at least " : ""}${item.open} open position${item.open === 1 ? "" : "s"} (open, exit pending or held).`);
  for (const agentId of exposure.unreadable) lines.push(`${agentId}: its positions could not be read (counted as open).`);
  const ids = [...new Set([...exposure.armed, ...exposure.positions.map((item) => item.agentId), ...exposure.unreadable])];
  lines.push("Stop-loss and take-profit stop while the runner is off, and stay off after it starts again until you arm "
    + `${ids.length === 1 ? "the agent" : "each agent"} again (balchemy runner arm ${ids.length === 1 ? ids[0] : "<agent-id>"}, or balchemy: it asks your passphrase once).`);
  return lines.join("\n");
}

export async function shutdownLocalRunner(directory: string): Promise<RunnerStatus> {
  requireUnixPlatform();
  const context = inspectContext(directory);
  if (!context.metadata) return status("stopped");
  // Shutdown remains available when the control journal has entered a hold.
  // The daemon itself validates the exact current instance before closing.
  const operationId = randomUUID();
  try {
    const result = await requestRunner(path.join(context.directory, SOCKET_FILE), {
      version: 1, id: operationId, action: "shutdown", instanceId: context.metadata.instanceId,
    });
    if (result.error === "state_unavailable" || (result.ok && result.daemon?.process !== "stopping")) throw new RunnerTransportError("outcome_unknown", operationId);
    if (!result.ok) throw new RunnerLifecycleError("control_rejected");
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      if (!exists(path.join(context.directory, DAEMON_FILE)) && !hasDaemonArtifacts(context.directory)) return status("stopped");
      // A replacement or corrupt instance must never be declared shut down.
      let current: DaemonMetadata | undefined;
      try { current = readDaemonMetadata(context.directory, context.profile!); }
      catch (error: unknown) {
        // The acknowledged host unlinks its metadata during this read, then closes its writer lock. Reconcile only a fully
        // absent instance. While the metadata is gone and the only artifact left is that busy writer lock, keep polling to
        // the deadline; corrupt or replacement metadata, a socket or a legacy lock directory stay held.
        if (!(error instanceof RunnerLifecycleError && error.code === "metadata_invalid") || exists(path.join(context.directory, DAEMON_FILE))) throw error;
        const remaining = daemonArtifacts(context.directory);
        if (remaining === "none") return status("stopped");
        if (remaining !== "writer_busy") throw error;
      }
      if (current && current.instanceId !== context.metadata.instanceId) throw new RunnerTransportError("outcome_unknown", operationId);
      await delay(25);
    }
    throw new RunnerTransportError("outcome_unknown", operationId);
  } catch (error: unknown) {
    if (error instanceof RunnerLifecycleError && error.code === "metadata_invalid") throw new RunnerTransportError("outcome_unknown", operationId);
    throw error;
  }
}
