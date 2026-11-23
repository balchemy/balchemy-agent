import * as fs from "node:fs";
import * as path from "node:path";
import { TerminalError } from "../errors.js";
import type { JsonValue } from "../output.js";
import { PACKAGE_VERSION } from "../package-version.js";
import { RunnerTransportError } from "./client.js";
import { RunnerDaemonError } from "./daemon.js";
import { disarmLocalAgent, formatRunnerShutdownWarning, inspectLocalRunner, readRunnerShutdownExposure, readRunnerVersion, recoverLocalRunner, registerLocalAgent,
  runnerDirectory, runnerShutdownExposed, shutdownLocalRunner, startLocalRunner, stopLocalAgent, validateRunnerArguments, type RunnerShutdownExposure, type RunnerStatus } from "./lifecycle.js";
import { formatRunnerKeepAwake, parseRunnerKeepAwake, readRunnerKeepAwake, type RunnerKeepAwake } from "./private-keep-awake.js";
import { RunnerLockError } from "./kernel-lock.js";
import { RunnerLifecycleError, readLocalProfile } from "./metadata.js";
import { knownRunnerAgents, RUNNER_NOT_RUNNING_TEXT, RUNNER_RESTART_EFFECT, runnerPowerNote, runnerRestartSteps, runnerStartHint, runnerUpgradeHint } from "./not-running.js";
import { readPairingAdoption, readPairingApproval } from "./pairing-identity.js";
import { RUNNER_CLOCK_SKEW_TEXT } from "./protocol.js";

/** Identity is local receipt state, not an online lease or execution permission. */
function publicStatus(value: RunnerStatus, directory: string, versions: { runner?: string | null; keepAwake?: RunnerKeepAwake | null } = {}): JsonValue {
  const profile = value.agents.length ? readLocalProfile(directory) : undefined;
  const agents = value.agents.map((agent) => {
    let pairing: "unpaired" | "awaiting_confirmation" | "paired" | "unavailable" = "unavailable";
    let serverAgentId: string | undefined;
    if (profile) {
      const options = { directory, localProfileId: profile.localProfileId, agentId: agent.agentId };
      try {
        const adopted = readPairingAdoption(options);
        if (adopted) { pairing = "paired"; serverAgentId = adopted.agentId; }
        else pairing = readPairingApproval(options) ? "awaiting_confirmation" : "unpaired";
      } catch { /* A corrupt or held identity must never be presented as paired. */ }
    }
    return { agentId: agent.agentId, version: agent.version, mode: agent.mode, lifecycle: agent.lifecycle,
      pairing, ...(serverAgentId ? { serverAgentId } : {}), ...(agent.hub ? { hub: { ...agent.hub } } : {}),
      ...(agent.brainObservation ? { brainObservation: { ...agent.brainObservation } } : {}),
      ...(agent.keystoreObservation ? { keystoreObservation: { ...agent.keystoreObservation } } : {}),
      ...(agent.submissionSecurity ? { submissionSecurity: { ...agent.submissionSecurity } } : {}),
      ...(agent.executionStatus ? { executionStatus: { ...agent.executionStatus } } : {}),
      armed: agent.armed, ...(agent.entries ? { entries: agent.entries } : {}), execution: "unavailable" };
  });
  const pairingStates = new Set(agents.map((agent) => agent.pairing));
  return {
    process: value.process, pairing: agents.length === 0 ? "not_inspected" : pairingStates.size === 1 ? agents[0]!.pairing : "mixed",
    brain: agents.some((agent) => agent.brainObservation) ? "reported_per_agent" : "not_reported", execution: value.execution, armed: value.armed, agents,
    cliVersion: PACKAGE_VERSION,
    // The running daemon's own package version; null when it does not report one (0.4.x) or the read failed.
    ...(versions.runner !== undefined ? { runnerVersion: versions.runner } : {}),
    // Phase 1: the daemon's sleep inhibitor; null when this runner does not report it (older, or the read failed).
    ...(versions.keepAwake !== undefined ? { keepAwake: versions.keepAwake ? { ...versions.keepAwake } : null } : {}),
    // Owner guidance only while stopped: the agents this runner directory knows (read-only).
    ...(value.process === "stopped" ? { knownAgents: knownRunnerAgents(directory) } : {}),
  };
}

const LIFECYCLE_USAGE = "Use runner start [agent-id ...], add <agent-id>, status [agent-id], stop <agent-id>, disarm <agent-id>, shutdown, or recover.";

/** Owner words for each closed local runner failure; the code itself goes only to --debug. */
function failureText(reason: string, action: string, directory: string, runningDaemon: boolean, agentId?: string): { cause: string; fix: string } {
  const known = knownRunnerAgents(directory);
  const restart = runnerUpgradeHint(known);
  switch (reason) {
    case "not_running":
      // `runner add` needs a running runner; starting it with the agent registers that agent too.
      if (action === "add") return { cause: RUNNER_NOT_RUNNING_TEXT, fix: `${runnerStartHint(agentId ? [...new Set([...known, agentId])] : known)}. Nothing was changed.` };
      return { cause: RUNNER_NOT_RUNNING_TEXT, fix: `${runnerStartHint(known.length ? known : undefined)}. Nothing was changed.` };
    case "socket_path_too_long":
      return { cause: "The runner folder path is too long for a local socket.", fix: "Use a shorter home folder path (HOME), then start again. Your data is kept." };
    case "unsupported_platform":
      return { cause: "The runner works on macOS and Linux only (not Windows or Alpine).", fix: "Use WSL2 with Ubuntu, or a Linux or macOS machine." };
    case "unsupported_locking":
      return { cause: "This system does not support the file locks the runner needs.", fix: "Use Linux with glibc or macOS 12+, on x64 or arm64 with Node 20+. Keep the local state intact." };
    case "agent_not_registered":
      // Owner decision of 19 Nov 2026: an agent is added to the running runner without a restart (no other agent is disarmed).
      return { cause: "This agent is not registered with the running runner.",
        fix: `Add it without restarting (no other agent is disarmed): balchemy runner add <agent-id>${known.length ? ` (known: ${known.join(", ")})` : ""}.` };
    case "agent_limit":
      return { cause: "The runner already has 64 agents, the most it can hold.", fix: "Nothing was changed. Use one of the agents it already has." };
    case "control_rejected":
      return { cause: "The running runner rejected this request.", fix: restart };
    case "lock_busy":
    case "recovery_required":
      if (action === "recover" && runningDaemon) return { cause: "A Balchemy runner is running now. Recovery is only for a runner that did not exit cleanly.",
        fix: "To stop it: balchemy runner shutdown. Your data is kept." };
      if (action === "recover") return { cause: "Recovery could not prove exclusive ownership of the runner folder.",
        fix: "Keep all local files intact; no lock deletion or PID-based termination is safe. If a runner is running, stop it with: balchemy runner shutdown." };
      return { cause: "The runner's state could not be confirmed.",
        fix: `If the runner did not exit cleanly (a crash or power loss), run: balchemy runner recover. Your data is kept. ${restart}` };
    default:
      return { cause: "The local runner did not confirm this command. Execution remains unavailable.",
        fix: `Check: balchemy runner status. ${restart}` };
  }
}

/** Phase 1 (17 Nov 2026): the shutdown confirmation. `interactive`: a real terminal without --json or --ci; `confirm` shows the
 * warning and reads one typed line (null when input closed). `readExposure` is a test seam. */
export interface RunnerCommandOptions {
  interactive?: boolean;
  confirm?(text: string): Promise<string | null>;
  readExposure?(directory: string): Promise<RunnerShutdownExposure | null>;
}
export const RUNNER_SHUTDOWN_PHRASE = "SHUTDOWN";

/** The production `confirm`: the warning, then one visible line in raw mode (nothing kept in history). */
export async function confirmRunnerShutdown(text: string): Promise<string | null> {
  const { createWalletPrompt, guardTerminalSignals } = await import("./private-trading-keystore-ui.js");
  await new Promise<void>((resolve, reject) => { process.stdout.write(text, (error) => error ? reject(error) : resolve()); });
  const prompt = createWalletPrompt();
  const release = guardTerminalSignals(() => prompt.close());
  try { return await prompt.line("shutdown> "); } finally { release(); prompt.close(); }
}

/** Refuses or asks before a shutdown that would leave an armed agent or open positions without stop-loss and take-profit. Returns
 * when the shutdown may proceed (nothing exposed, or SHUTDOWN typed). --yes never reaches here (index.ts refuses it). */
async function confirmShutdownExposure(directory: string, options: RunnerCommandOptions): Promise<void> {
  const exposure = await (options.readExposure ?? readRunnerShutdownExposure)(directory);
  if (!runnerShutdownExposed(exposure)) return;
  const warning = formatRunnerShutdownWarning(exposure);
  if (!options.interactive || !options.confirm) {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Shutdown needs a typed confirmation", cause: warning,
      fix: `Nothing was stopped. Run balchemy runner shutdown in a terminal (without --json or --ci) and type ${RUNNER_SHUTDOWN_PHRASE}, `
        + "or close the positions first. A script cannot confirm this.", commandSuggestion: "balchemy runner shutdown", exitCode: 2 });
  }
  const answer = await options.confirm(`${warning}\nType exactly ${RUNNER_SHUTDOWN_PHRASE} to stop the runner anyway; any other answer cancels.\n`);
  if (answer !== RUNNER_SHUTDOWN_PHRASE) {
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Shutdown cancelled", cause: `You did not type ${RUNNER_SHUTDOWN_PHRASE}.`,
      fix: "Nothing was stopped; the runner keeps running and protecting your positions.", commandSuggestion: "balchemy runner status", exitCode: 1 });
  }
}

export async function runRunnerCommand(action: string, args: string[], dryRun: boolean, options: RunnerCommandOptions = {}): Promise<JsonValue> {
  let directory: string | undefined;
  try {
    // A bare `runner start` starts the runner again with the agents it already knows, without resuming any the owner stopped.
    const bare = action === "start" && args.length === 0;
    const known = bare ? knownRunnerAgents(runnerDirectory()) : [];
    if (bare && known.length === 0) {
      throw new TerminalError({ code: "RUNTIME_ERROR", title: "No known agents yet", cause: "This runner has not been started with any agent yet.",
        fix: "Start one: balchemy runner start <agent-id> (for example: balchemy runner start alpha).", commandSuggestion: "balchemy runner start alpha", exitCode: 2 });
    }
    validateRunnerArguments(action, bare ? known : args);
    if (dryRun) return { dryRun: true, action, pairing: "unpaired", brain: "not_reported", execution: "unavailable", armed: false };
    directory = runnerDirectory();
    switch (action) {
      case "start": return publicStatus(await startLocalRunner(directory, bare ? known : args, bare ? { resume: false } : {}), directory,
        { runner: await readRunnerVersion(directory), keepAwake: await readRunnerKeepAwake(directory) });
      // Owner decision of 19 Nov 2026: adds an agent to the running runner; every other agent keeps running as it is.
      case "add": return publicStatus(await registerLocalAgent(directory, args[0]!), directory);
      case "status": {
        const status = await inspectLocalRunner(directory, args[0]);
        return publicStatus(status, directory, status.process === "running"
          ? { runner: await readRunnerVersion(directory), keepAwake: await readRunnerKeepAwake(directory) } : {});
      }
      case "stop": return publicStatus(await stopLocalAgent(directory, args[0]!), directory);
      case "disarm": return publicStatus(await disarmLocalAgent(directory, args[0]!), directory);
      case "shutdown": {
        // Phase 1: read first (nothing is unlocked or changed); an armed agent or open positions need the typed SHUTDOWN.
        await confirmShutdownExposure(directory, options);
        return publicStatus(await shutdownLocalRunner(directory), directory);
      }
      case "recover": return publicStatus(await recoverLocalRunner(directory), directory);
    }
  } catch (error: unknown) {
    if (error instanceof TerminalError) throw error;
    const invalid = error instanceof RunnerLifecycleError && error.code === "invalid_arguments";
    const unknown = (error instanceof RunnerTransportError && error.code === "outcome_unknown")
      || (error instanceof RunnerLifecycleError && error.code === "shutdown_unknown");
    const reason = error instanceof RunnerLifecycleError || error instanceof RunnerDaemonError || error instanceof RunnerTransportError || error instanceof RunnerLockError
      ? error.code : "local_state_unavailable";
    const resolved = directory ?? runnerDirectory();
    // Recovery refused while a daemon still answers: say so, and name the command that stops it.
    const runningDaemon = action === "recover" && !invalid && !unknown
      ? await inspectLocalRunner(resolved).then((status) => status.process === "running", () => false) : false;
    const text = invalid ? { cause: LIFECYCLE_USAGE, fix: "Use local agent labels containing letters, numbers, dots, underscores, colons or hyphens." }
      : unknown ? { cause: "The runner did not confirm whether this command applied. Nothing was retried.", fix: "Check now: balchemy runner status." }
      : failureText(reason, action, resolved, runningDaemon, action === "add" ? args[0] : undefined);
    throw new TerminalError({
      code: unknown ? "RUNTIME_OUTCOME_UNKNOWN" : "RUNTIME_ERROR",
      title: invalid ? "Invalid local runner command" : unknown ? "Runner outcome unknown" : "Local runner command did not complete",
      cause: text.cause,
      fix: text.fix,
      commandSuggestion: invalid ? "balchemy runner --help" : "balchemy runner status",
      exitCode: invalid ? 2 : 1,
      retryable: false,
      debugDetails: `runner state: ${reason}`,
      ...(error instanceof RunnerTransportError && error.operationId ? { operationId: error.operationId } : {}),
    });
  }
}

// ---- human output ----------------------------------------------------------------------------------------------------
type Json = { [key: string]: JsonValue };
const record = (value: JsonValue | undefined): Json | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;

function age(iso: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 120) return `${seconds}s ago`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}
/** Older than this, a "reporting" connection is shown as not confirmed lately: Hub may show the agent offline. */
const HUB_STALE_MS = 3 * 60_000;
export function formatHubLine(agentId: string, hub: Json | undefined, now: number = Date.now()): string {
  if (!hub) return "    Hub: not reported by this runner.";
  const last = typeof hub.lastConfirmedAt === "string" ? hub.lastConfirmedAt : undefined;
  switch (hub.connection) {
    case "not_paired": return `    Hub: not paired. Pair it: balchemy runner pair ${agentId}`;
    case "connecting": return "    Hub: connecting (no report confirmed yet).";
    case "reporting":
      if (last && now - Date.parse(last) > HUB_STALE_MS) return `    Hub: no report confirmed since ${age(last, now)}. The runner keeps running locally; Hub may show it offline.`;
      return `    Hub: connected${last ? ` (last report ${age(last, now)})` : ""}.`;
    default:
      if (hub.reason === "clock_skew") return `    Hub: offline${last ? ` (last report ${age(last, now)})` : ""}. ${RUNNER_CLOCK_SKEW_TEXT}`;
      return `    Hub: offline${last ? ` (last report ${age(last, now)})` : ""}. The runner keeps running locally; Hub shows it offline.`;
  }
}
export function formatTradingWalletLine(agentId: string, lock: JsonValue | undefined): string | undefined {
  switch (lock) {
    case "not_configured": return `    Trading wallet: none. Create one: balchemy runner wallet ${agentId} create`;
    case "locked": return "    Trading wallet: locked.";
    case "unlocked": return `    Trading wallet: unlocked (the key is in memory until you lock it or the runner stops). Lock: balchemy runner wallet ${agentId} lock`;
    case "unavailable": return `    Trading wallet: status unavailable. Check: balchemy runner wallet ${agentId} status`;
    default: return undefined;
  }
}
const PAIRING_WORDS: Record<string, string> = { unpaired: "not paired", awaiting_confirmation: "waiting for your confirmation", paired: "paired",
  unavailable: "unavailable", mixed: "mixed (see each agent)", not_inspected: "not checked (runner stopped)" };

/** Version line for a running runner, with the exact restart steps when it runs other code than this CLI. */
export function formatVersionLines(runnerVersion: JsonValue | undefined, cliVersion: string, agentIds: readonly string[]): string[] {
  if (runnerVersion === undefined) return [];
  const restart = [`  Restart it to use this version: ${runnerRestartSteps(agentIds)}.`, `  ${RUNNER_RESTART_EFFECT}`];
  if (typeof runnerVersion !== "string") return [`Runner version not reported (a runner older than 0.5.0 does not report it; CLI v${cliVersion}).`, ...restart];
  if (runnerVersion !== cliVersion) return [`Runner v${runnerVersion} (CLI v${cliVersion}): the running runner is a different version than this CLI.`, ...restart];
  return [`Runner v${runnerVersion} (CLI v${cliVersion}).`];
}

/** Human output of runner start/status/stop/disarm/shutdown/recover. Formatting only; the JSON is the contract. */
export async function formatRunnerStatus(action: string, data: JsonValue, options: { dryRun?: boolean; now?: number } = {}): Promise<string> {
  const status = record(data) ?? {};
  if (options.dryRun) return "Local runner action preview; no changes made.\n";
  const lines: string[] = [];
  const agents = Array.isArray(status.agents) ? status.agents.map((item) => record(item) ?? {}) : [];
  const ids = agents.map((agent) => String(agent.agentId));
  if (status.process !== "running") {
    const known = Array.isArray(status.knownAgents) ? status.knownAgents.map(String) : [];
    if (action === "shutdown") lines.push("Runner stopped. Trading wallet keys were cleared from memory and Hub will show your agents offline.",
      "Nothing trades or sells while it is stopped.");
    else if (action === "recover") lines.push("Recovery finished. The runner stays stopped; your data is kept.");
    else lines.push(RUNNER_NOT_RUNNING_TEXT);
    if (known.length) lines.push(`Known agents: ${known.join(", ")}.`, `${runnerStartHint(known)} (or just: balchemy runner start)`);
    else lines.push(runnerStartHint());
    lines.push(runnerPowerNote(known.length === 1 ? known[0] : undefined), "After a restart, start it again, then unlock your trading wallet.");
    return `${lines.join("\n")}\n`;
  }
  if (action === "stop") {
    for (const id of ids) lines.push(`Agent ${id} stopped. The runner is still running; to stop everything: balchemy runner shutdown`);
    return `${lines.join("\n")}\n`;
  }
  // Owner decision of 19 Nov 2026: added to the running runner; nothing else was restarted, disarmed or changed.
  if (action === "add") for (const id of ids) lines.push(`Agent ${id} is registered with the running runner (shadow mode; it cannot trade). Your other agents were not changed.`);
  lines.push("Runner: running.", ...formatVersionLines(status.runnerVersion, typeof status.cliVersion === "string" ? status.cliVersion : PACKAGE_VERSION, ids));
  // Phase 1: the sleep inhibitor, when this reply carries it (status and start).
  if (status.keepAwake !== undefined) {
    let keepAwake: RunnerKeepAwake | null = null;
    try { keepAwake = status.keepAwake === null ? null : parseRunnerKeepAwake(status.keepAwake); } catch { keepAwake = null; }
    lines.push(formatRunnerKeepAwake(keepAwake));
  }
  lines.push(`Identity pairing: ${PAIRING_WORDS[String(status.pairing)] ?? String(status.pairing)}. Armed: ${status.armed === true ? "yes" : "no"}.`);
  for (const agent of agents) {
    const agentId = String(agent.agentId);
    lines.push(`  ${agentId}: ${String(agent.lifecycle)}, ${String(agent.mode)}${agent.entries === "paused" ? " (new entries paused)" : ""}, identity ${PAIRING_WORDS[String(agent.pairing)] ?? String(agent.pairing)}.`);
    if (agent.lifecycle === "stopped") lines.push(`    Stopped. Resume it: balchemy runner start ${agentId}`);
    lines.push(formatHubLine(agentId, record(agent.hub), options.now));
    // On every status reply, armed or not (a restart always disarms); the exits capability is the daemon's own.
    const keystoreObservation = record(agent.keystoreObservation);
    const walletLine = formatTradingWalletLine(agentId, keystoreObservation?.lock);
    if (walletLine) lines.push(walletLine);
    if (keystoreObservation?.lock === "locked") {
      const { formatRunnerKeystoreLock } = await import("./private-trading-keystore-ui.js");
      lines.push(formatRunnerKeystoreLock(agentId, { armed: agent.mode === "live_armed", exitsAvailable: keystoreObservation.exits === "available" }).replace(/\n$/, ""));
    }
    const security = record(agent.submissionSecurity);
    if (security) {
      lines.push(`    SECURITY WARNING: a transaction with your key was signed outside Balchemy (${String(security.unacknowledgedResignedCopies)} unacknowledged).`);
      lines.push(`    New autonomous trades for this wallet are held. Review: balchemy runner trades ${agentId}; then balchemy runner wallet ${agentId} acknowledge-copy`);
    }
    const execution = record(agent.executionStatus);
    if (execution) {
      const limits = record(execution.limits); const queue = record(execution.queue); const last = record(queue?.last);
      lines.push(`    Autonomous execution: ${agent.mode === "live_armed" ? agent.entries === "paused" ? "armed, new entries paused" : "armed, new entries enabled" : "not armed"}; trading keystore ${String(execution.keystore)}.`);
      if (limits) {
        const { formatPrivateCap, formatPrivateSpendRemaining, parsePrivateCapSetting, parsePrivateSpendRemaining } = await import("./private-spend-cap.js");
        try {
          const perTrade = parsePrivateCapSetting(limits.perTrade, { allowUnset: true }), daily = parsePrivateCapSetting(limits.daily, { allowUnset: true });
          lines.push(`    Spend caps: per trade ${formatPrivateCap(perTrade)}, daily ${formatPrivateCap(daily)}, remaining today ${formatPrivateSpendRemaining(parsePrivateSpendRemaining(limits.remaining))}.`
            + (perTrade.kind === "unset" ? ` Set them: balchemy runner wallet ${agentId} limits --per-trade <SOL|N%|none> --daily <SOL|N%|none>` : ""));
        } catch { lines.push("    Spend caps: unavailable."); }
      } else lines.push(`    Spend caps: ${String(execution.limits)}.`);
      if (queue) {
        lines.push(`    Execution queue: ${String(queue.queued)} queued, ${String(queue.running)} running${queue.waiting === "keystore_locked" ? "; waiting for the trading keystore to be unlocked" : ""}.`);
        if (last) {
          // M3.2 S5: Balchemy's signed-cap refusals get plain owner text (the one-time wallet approval cannot be requested yet).
          const { privateExecutionReasonText } = await import("./private-signal-ui.js");
          const explained = typeof last.reason === "string" ? privateExecutionReasonText(last.reason) : null;
          lines.push(`    Last execution outcome: ${String(last.state)}${last.reason === null ? "" : ` (${String(last.reason)})`}. Details: balchemy runner decisions ${agentId}`);
          if (explained) lines.push(`    ${explained}`);
        }
      } else lines.push("    Execution queue: unavailable.");
      if (execution.exits !== undefined) {
        const { formatRunnerExitSummary } = await import("./private-position-ui.js");
        lines.push(formatRunnerExitSummary(agentId, execution.exits as unknown as Parameters<typeof formatRunnerExitSummary>[1],
          { clockSkew: record(agent.hub)?.reason === "clock_skew" }).replace(/\n$/, ""));
      }
      if (execution.dca !== undefined) {
        const { formatPrivateDcaStatus } = await import("./private-dca.js");
        const line = formatPrivateDcaStatus(execution.dca as unknown as Parameters<typeof formatPrivateDcaStatus>[0]);
        if (line) lines.push(`    ${line}.`);
      }
    }
    const observation = record(agent.brainObservation);
    if (observation) {
      const ruleLabels: Record<string, string> = { confirmed: "Owner confirmation recorded", missing: "No confirmed rules",
        held: "Confirmed rules held for review", unavailable: "Unavailable", not_checked: "Confirmation not yet checked on this runner" };
      lines.push(`    Model: ${String(observation.model)}.`);
      lines.push(`    Solana rules: ${ruleLabels[String(observation.rules)] ?? "Unavailable"}.`);
      lines.push(`    Decision processing: ${String(observation.activity)}.`);
      lines.push(`    Last decision processing outcome this session: ${String(observation.lastTerminal)}.`);
    } else lines.push("    Brain status: not reported.");
  }
  if (action === "start") lines.push(runnerPowerNote(ids.length === 1 ? ids[0] : undefined), "After a restart, start it again with: balchemy runner start, then unlock your trading wallet.");
  return `${lines.join("\n")}\n`;
}

// ---- doctor --runner -------------------------------------------------------------------------------------------------
export interface RunnerDoctorCheck { name: string; status: "ok" | "warn" | "error"; detail: string }
/** Read-only runner diagnostics: never starts, stops, recovers or writes anything, and opens no network connection itself
 * (the Hub line is what the running daemon reports). */
export async function runnerDoctorChecks(directory: string = runnerDirectory(), now: number = Date.now()): Promise<RunnerDoctorCheck[]> {
  const checks: RunnerDoctorCheck[] = [];
  const supported = process.platform === "darwin" || process.platform === "linux";
  checks.push({ name: "platform", status: supported ? "ok" : "error", detail: supported ? `${process.platform} ${process.arch}`
    : "The runner works on macOS and Linux only (not Windows). Use WSL2 with Ubuntu, or a Linux machine." });
  let folder: "missing" | "private" | "unsafe" = "missing";
  try {
    const stat = fs.lstatSync(directory);
    folder = !stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o077) === 0 ? "private" : "unsafe";
  } catch { /* missing */ }
  checks.push({ name: "runner-folder", status: folder === "unsafe" ? "error" : folder === "missing" ? "warn" : "ok",
    detail: folder === "missing" ? `${directory} does not exist yet (created by the first runner start)`
      : folder === "unsafe" ? `${directory} is not a private directory (mode 700, owned by you); keep it intact and contact support` : `${directory} (private)` });
  const socketPath = path.join(directory, "control.sock");
  let socket = false; try { socket = fs.lstatSync(socketPath).isSocket(); } catch { /* absent */ }
  checks.push({ name: "socket", status: "ok", detail: socket ? `${socketPath} present` : "no control socket (expected while the runner is stopped)" });
  let status: RunnerStatus | undefined; let failure: string | undefined;
  try { status = await inspectLocalRunner(directory); }
  catch (error: unknown) { failure = error instanceof RunnerLifecycleError || error instanceof RunnerLockError || error instanceof RunnerDaemonError ? error.code : "local_state_unavailable"; }
  const known = knownRunnerAgents(directory);
  if (failure) checks.push({ name: "daemon", status: "error", detail: `${failureText(failure, "status", directory, false).cause} ${failureText(failure, "status", directory, false).fix}` });
  else if (status?.process !== "running") checks.push({ name: "daemon", status: "warn", detail: `${RUNNER_NOT_RUNNING_TEXT} ${runnerStartHint(known.length ? known : undefined)}` });
  else checks.push({ name: "daemon", status: "ok", detail: `running with ${status.agents.map((agent) => agent.agentId).join(", ") || "no agents"}` });
  checks.push({ name: "known-agents", status: "ok", detail: known.length ? known.join(", ") : "none yet" });
  if (status?.process === "running") {
    const runner = await readRunnerVersion(directory);
    const lines = formatVersionLines(runner, PACKAGE_VERSION, known);
    checks.push({ name: "version", status: runner === PACKAGE_VERSION ? "ok" : "warn", detail: lines.map((line) => line.trim()).join(" ") });
    for (const agent of status.agents) {
      const hub = agent.hub ? { ...agent.hub } as unknown as Json : undefined;
      checks.push({ name: `hub ${agent.agentId}`, status: hub?.connection === "reporting" ? "ok" : "warn", detail: formatHubLine(agent.agentId, hub, now).replace(/^\s*Hub: /, "") });
    }
  } else checks.push({ name: "version", status: "ok", detail: `CLI v${PACKAGE_VERSION}; the runner is not running` });
  checks.push({ name: "logs", status: "ok", detail: "The runner keeps no log file in this version; use runner status, runner trades and runner positions." });
  return checks;
}
