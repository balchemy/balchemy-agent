/** One owner-facing wording for "the runner is not started" and for restarting it after an upgrade. */
import * as fs from "node:fs";
import * as path from "node:path";
import { TerminalError } from "../errors.js";
import { inspectDirectory } from "./metadata.js";
import { isId, isRecord } from "./protocol.js";
import { SNAPSHOT_FILE } from "./state.js";

/** Agent IDs this runner directory already knows (registration order), read-only from the control snapshot without any lock.
 * Only for owner guidance while the runner is stopped and for a bare `runner start`; never authority. Unreadable means none. */
export function knownRunnerAgents(input: string): string[] {
  try {
    const directory = inspectDirectory(input);
    if (!directory) return [];
    const file = path.join(directory, SNAPSHOT_FILE);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 2 * 1024 * 1024 || (stat.mode & 0o077) !== 0
      || (process.getuid && stat.uid !== process.getuid())) return [];
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!isRecord(value) || !Array.isArray(value.agents)) return [];
    const ids = value.agents.map((agent: unknown) => isRecord(agent) ? agent.agentId : undefined).filter((id): id is string => isId(id));
    return [...new Set(ids)].slice(0, 64);
  } catch { return []; }
}

export const RUNNER_NOT_RUNNING_TEXT = "The Balchemy runner is not running.";

/** "Start it with: balchemy runner start alpha", or `<agent-id>` when the agent is not known. */
export function runnerStartHint(agentIds?: string | readonly string[]): string {
  const ids = typeof agentIds === "string" ? [agentIds] : [...(agentIds ?? [])];
  return `Start it with: balchemy runner start ${ids.length ? ids.join(" ") : "<agent-id>"}`;
}

/** The exact restart after an upgrade: a running daemon keeps its old code until it is shut down and started again.
 * With known agents it is a bare `runner start`: that registers every known agent and resumes none, so an agent the owner
 * stopped stays stopped (explicit IDs would resume it, and a partial list would leave agents out). `<agent-id>` only when
 * no agent is known. */
export function runnerRestartSteps(agentIds?: readonly string[]): string {
  return `balchemy runner shutdown, then balchemy runner start${agentIds?.length ? "" : " <agent-id>"}`;
}
/** What a restart, shutdown or sleep of this computer does to the runner. The daemon has no sleep or wake handling: a
 * sleeping computer only pauses it, so an unlocked trading wallet stays unlocked across sleep. */
export function runnerPowerNote(agentId?: string): string {
  return "The runner stops when this computer restarts or shuts down, and does nothing while it sleeps; an unlocked wallet stays "
    + `unlocked across sleep (lock it with: balchemy runner wallet ${agentId ?? "<id>"} lock).`;
}
export const RUNNER_RESTART_EFFECT = "A restart locks your trading wallet and disarms; unlock it again afterwards. "
  + "Open positions have no stop-loss or take-profit until you arm again (balchemy runner arm <agent-id> asks your passphrase once for both).";

/** A command that needs the runner found no running runner. `known` lists the agents this runner directory knows, so
 * an unknown agent name is told apart from a runner that is simply not started. Nothing was changed. */
export function runnerNotRunningError(agentId: string | undefined, known: readonly string[] = [], title = "Runner not running"): TerminalError {
  const unknown = agentId !== undefined && known.length > 0 && !known.includes(agentId);
  return new TerminalError({ code: "RUNTIME_ERROR", title,
    cause: unknown ? `${RUNNER_NOT_RUNNING_TEXT} This runner also has no agent named ${agentId} (known agents: ${known.join(", ")}).`
      : RUNNER_NOT_RUNNING_TEXT,
    fix: `${runnerStartHint(unknown ? known : agentId)}, then try again. Nothing was changed.`, exitCode: 1 });
}

/** For a reply this CLI could not validate or a request the runner rejected: after an upgrade the still-running runner
 * keeps the older code, which is the usual cause. Names the exact restart and its effect. */
export function runnerUpgradeHint(agentIds?: readonly string[]): string {
  return `If you upgraded balchemy while the runner was running, it still runs the older version. Restart it: ${runnerRestartSteps(agentIds)}. ${RUNNER_RESTART_EFFECT}`;
}
