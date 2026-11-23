/** Public local entry. Inspect first; every mutation remains an explicit choice. */
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import type { CliFlags } from "./cli-options.js";
import { TerminalError } from "./errors.js";
import { isId } from "./runner/protocol.js";
import type { RunnerStatus } from "./runner/lifecycle.js";
import { knownRunnerAgents, RUNNER_NOT_RUNNING_TEXT } from "./runner/not-running.js";

export interface LocalEntryPrompt { ask(question: string): Promise<string | null>; close(): void }
export interface LocalEntryDependencies {
  inspect(): Promise<RunnerStatus>;
  start(agentId: string): Promise<RunnerStatus>;
  /** Agent IDs the runner folder already knows (read-only); shown while the runner is stopped. */
  known?(): string[];
}
export interface LocalEntryOverview {
  kind: "overview"; process: "running" | "stopped"; execution: "unavailable"; armed: false;
  agents: Array<{ agentId: string; mode: string; lifecycle: string }>;
  /** Only while stopped: agents this runner folder knows. */
  knownAgents?: string[];
  nextActions: string[];
}
export type LocalEntryRoute = { kind: "route"; command: "runner chat" | "runner model" | "runner model-save"
  | "runner model-unlock" | "runner model-status" | "runner rules" | "runner pair" | "runner stop" | "runner start" | "runner wallet"
  | "runner status"; args: string[] };
export type LocalEntryResult = LocalEntryOverview | LocalEntryRoute | { kind: "cancelled" }
  | { kind: "preview"; execution: "unavailable"; inspected: false; changes: false };
interface Options {
  args: string[]; flags: Pick<CliFlags, "json" | "ci" | "dryRun" | "yes" | "force" | "quiet">;
  interactive: boolean; write(text: string): void;
  dependencies?: LocalEntryDependencies; createPrompt?(): LocalEntryPrompt;
}

export function createLocalEntryPrompt(): LocalEntryPrompt {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true, historySize: 0 });
  let closed = false; let pending: ((value: string | null) => void) | undefined;
  rl.on("line", (value) => { const resolve = pending; pending = undefined; resolve?.(value); });
  rl.on("close", () => { closed = true; const resolve = pending; pending = undefined; resolve?.(null); });
  rl.on("SIGINT", () => rl.close());
  return {
    ask: (question) => new Promise((resolve) => {
      if (closed) { resolve(null); return; }
      pending = resolve; rl.setPrompt(question); rl.prompt();
    }),
    close: () => rl.close(),
  };
}
const localDependencies: LocalEntryDependencies = {
  inspect: async () => {
    const { inspectLocalRunner, runnerDirectory } = await import("./runner/lifecycle.js");
    return inspectLocalRunner(runnerDirectory());
  },
  start: async (agentId) => {
    const { startLocalRunner, runnerDirectory } = await import("./runner/lifecycle.js");
    return startLocalRunner(runnerDirectory(), [agentId]);
  },
  known: () => knownRunnerAgents(path.join(os.homedir(), ".balchemy", "runner")),
};
function unavailable(starting: boolean): TerminalError {
  return new TerminalError({ code: starting ? "RUNTIME_OUTCOME_UNKNOWN" : "RUNTIME_ERROR",
    title: starting ? "Local start not confirmed" : "Local status unavailable",
    cause: starting ? "The requested agent's current state was not confirmed. It may have started."
      : "The local service could not be safely inspected.",
    fix: "Run balchemy runner status. Keep local state intact; use balchemy runner recover only after a crash or power loss. No legacy setup was opened.",
    exitCode: 1, retryable: false });
}
export function formatLocalOverview(value: LocalEntryOverview): string {
  const rows = ["Balchemy — local agents", `Service: ${value.process}. Execution unavailable.`,
    ...value.agents.map((agent) => `${agent.agentId}: ${agent.lifecycle}, ${agent.mode}.`),
    ...(value.process === "stopped" ? [RUNNER_NOT_RUNNING_TEXT, ...(value.knownAgents?.length
      ? [`Known agents: ${value.knownAgents.join(", ")}. Start them again: balchemy runner start`] : [])] : []),
    "Private rules and chat stay on this device.",
    "Closing this terminal leaves the service running."];
  return rows.join("\n") + "\n";
}
function overview(status: RunnerStatus, known: string[]): LocalEntryOverview {
  return { kind: "overview", process: status.process, execution: "unavailable", armed: false,
    agents: status.agents.map(({ agentId, mode, lifecycle }) => ({ agentId, mode, lifecycle })),
    ...(status.process === "stopped" && known.length ? { knownAgents: known } : {}),
    nextActions: ["balchemy init", "balchemy runner status --json", "balchemy --help"] };
}
function cancelled(write: Options["write"]): LocalEntryResult {
  write("Left local setup. No further action was requested.\n"); return { kind: "cancelled" };
}

export async function runLocalEntry(options: Options): Promise<LocalEntryResult> {
  if (options.args.length || options.flags.yes || options.flags.force) throw new TerminalError({ code: "RUNTIME_ERROR",
    title: "Explicit local setup required", cause: "Local entry does not accept extra arguments, --yes or --force.",
    fix: "Run balchemy init to choose an agent and review its start, or use an explicit runner command.", exitCode: 2 });
  if (options.flags.dryRun) {
    if (!options.flags.json) options.write("Local setup preview. No status read, prompt or change made.\nRun balchemy init to choose a local agent explicitly.\n");
    return { kind: "preview", execution: "unavailable", inspected: false, changes: false };
  }
  const dependencies = options.dependencies ?? localDependencies;
  let state: RunnerStatus;
  try { state = await dependencies.inspect(); } catch { throw unavailable(false); }
  let known: string[] = [];
  try { known = state.process === "stopped" ? dependencies.known?.() ?? [] : []; } catch { known = []; }
  const view = overview(state, known);
  if (!options.flags.json) options.write(formatLocalOverview(view));
  if (!options.interactive || options.flags.json || options.flags.ci || options.flags.quiet) {
    if (!options.flags.json) options.write("Read-only overview. Use balchemy init in a terminal to continue.\n");
    return view;
  }
  const prompt = (options.createPrompt ?? createLocalEntryPrompt)();
  try {
    let agentId: string;
    if (state.process === "stopped") {
      options.write("Choose a local agent ID to set up or resume.\nNo model, wallet or Hub account is required.\nLeave the ID blank to exit without starting.\n");
      const answer = await prompt.ask("Local agent ID: ");
      if (answer === null || answer.trim() === "") return cancelled(options.write);
      agentId = answer.trim();
      if (!isId(agentId)) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid local agent ID",
        cause: "Use 1–160 letters, digits, dots, underscores, colons or hyphens; begin with a letter or digit.",
        fix: "Run balchemy init again with an explicit local label, such as alpha.", exitCode: 2 });
      options.write(`Start ${agentId} in shadow mode?\nThis creates or resumes this local agent.\nThe service runs after the terminal closes.\nIt cannot trade; no reboot service is installed.\n`);
      const approval = await prompt.ask(`Type START ${agentId}: `);
      if (approval !== `START ${agentId}`) return cancelled(options.write);
      try { state = await dependencies.start(agentId); } catch { throw unavailable(true); }
      const started = state.agents.find((agent) => agent.agentId === agentId);
      if (state.process !== "running" || !started || started.mode !== "shadow" || started.lifecycle !== "idle"
        || started.armed || started.execution !== "unavailable") throw unavailable(true);
      options.write([`Local agent ${agentId} is running in shadow mode.`, "Execution is unavailable.",
        `Next: pair with Hub (menu: pair), connect a model (menu: model), then create a trading wallet (menu: wallet).`,
        "The runner stops when this computer restarts or shuts down, and does nothing while it sleeps; an unlocked wallet stays unlocked "
          + `across sleep (lock it with: balchemy runner wallet ${agentId} lock). After a restart, start it again with: balchemy runner start ${agentId}, then unlock your wallet.`, ""].join("\n"));
    } else {
      options.write("Choose an exact agent ID, or leave blank to exit.\nTo add an ID, explicitly shut down the service\nand start it with all the IDs you want active.\n");
      const answer = await prompt.ask("Agent ID: ");
      if (answer === null || answer.trim() === "") return cancelled(options.write);
      agentId = answer.trim();
      if (!state.agents.some((agent) => agent.agentId === agentId)) throw new TerminalError({ code: "RUNTIME_ERROR",
        title: "Local agent not in this service", cause: "Choose an exact agent ID returned by the current local service.",
        fix: "Use balchemy runner status --json to inspect the current agents. No setup or resume was attempted.", exitCode: 2 });
    }
    options.write(`\nManage ${agentId}\nchat          Attach to private chat\nmodel         Set a temporary model and key\nsave-model    Save a model with a passphrase\nunlock-model  Unlock a saved model\nmodel-status  Inspect active/saved model state\nrules         Review and propose local rules\npair          Begin explicit Hub wallet pairing\nwallet        Trading wallet status and the next step (create or unlock)\nstatus        Show runner status\nresume        Resume this agent in shadow mode\nstop          Stop this agent\nquit          Leave the service running\n`);
    const action = await prompt.ask("Action: ");
    if (action === null || action.trim() === "" || action.trim() === "quit") return cancelled(options.write);
    const routes = { chat: "runner chat", model: "runner model", "save-model": "runner model-save",
      "unlock-model": "runner model-unlock", "model-status": "runner model-status", pair: "runner pair" } as const;
    const choice = action.trim();
    if (Object.hasOwn(routes, choice)) return { kind: "route", command: routes[choice as keyof typeof routes], args: [agentId] };
    if (choice === "wallet") return { kind: "route", command: "runner wallet", args: [agentId, "status"] };
    if (choice === "status") return { kind: "route", command: "runner status", args: [agentId] };
    if (choice === "rules") {
      const chain = await prompt.ask("Chain (solana/base): ");
      if (chain === null || chain.trim() === "" || chain.trim() === "quit") return cancelled(options.write);
      if (chain !== "solana" && chain !== "base") throw new TerminalError({ code: "RUNTIME_ERROR", title: "Choose a supported chain",
        cause: "Private rules currently support Solana and Base.", fix: "Use balchemy runner rules <id> solana or base.", exitCode: 2 });
      return { kind: "route", command: "runner rules", args: [agentId, chain, "edit"] };
    }
    if (choice === "resume") {
      options.write(`Resume only ${agentId} in shadow mode. Execution stays unavailable.\n`);
      if (await prompt.ask(`Type START ${agentId}: `) !== `START ${agentId}`) return cancelled(options.write);
      return { kind: "route", command: "runner start", args: [agentId] };
    }
    if (choice === "stop") {
      options.write(`Stop only ${agentId}. The service and other agents keep running.\n`);
      if (await prompt.ask(`Type STOP ${agentId}: `) !== `STOP ${agentId}`) return cancelled(options.write);
      return { kind: "route", command: "runner stop", args: [agentId] };
    }
    throw new TerminalError({ code: "RUNTIME_ERROR", title: "Unknown local action", cause: "No action was selected.",
      fix: "Run balchemy again and choose one of the listed local actions.", exitCode: 2 });
  } finally { prompt.close(); }
}
