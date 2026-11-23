#!/usr/bin/env node
/**
 * balchemy CLI entry point.
 *
 * Public terminal surface: the chat cockpit, the local entry and the local runner.
 * The external MCP connection model and its commands were removed in 0.9.0.
 */

import * as readline from "node:readline";
import { createRequire } from "node:module";
import { C, setNoColor } from "./colors.js";
import { commandKey, parseCliArgs } from "./cli-options.js";
import { createReporter, jsonEnvelope, type JsonValue } from "./output.js";
import {
  renderTerminalError,
  terminalErrorToJson,
  TerminalError,
  toTerminalError,
} from "./errors.js";

const require = createRequire(import.meta.url);
const CLI_MANIFEST = require("../package.json") as { version?: string; engines?: { node?: string } };
const CLI_VERSION = CLI_MANIFEST.version ?? "unknown";
/** Minimum Node major, parsed from package.json "engines.node" (for example ">=20.0.0"). */
const REQUIRED_NODE_MAJOR = Number.parseInt(/(\d+)/.exec(CLI_MANIFEST.engines?.node ?? "")?.[1] ?? "20", 10);
const parsed = parseCliArgs(process.argv.slice(2));

if (parsed.flags.noColor) {
  setNoColor();
}

const reporter = createReporter(parsed.flags);
let cmd = commandKey(parsed.commandPath);
let args = parsed.args;

function ask(rl: readline.Interface, question: string, defaultVal = ""): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` ${C.D}[${defaultVal}]${C.R}` : "";
    rl.question(`  ${C.T}${question}${C.R}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function ensureInteractive(commandName: string): void {
  if (parsed.flags.json) {
    throw new TerminalError({
      code: "TERMINAL_UNSUPPORTED_TUI",
      title: "Interactive terminal required",
      cause: `${commandName} launches an interactive TUI and cannot run with --json.`,
      fix: "Use a non-interactive command for automation, such as balchemy runner status --json.",
      commandSuggestion: "balchemy doctor --json",
      exitCode: 2,
    });
  }
  if (parsed.flags.ci || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TerminalError({
      code: parsed.flags.ci ? "CI_PROMPT_BLOCKED" : "TERMINAL_UNSUPPORTED_TUI",
      title: "Interactive terminal required",
      cause: `${commandName} needs a TTY, but this session is non-interactive.`,
      fix: "Run the command in a terminal, or use read-only commands such as balchemy runner status in CI.",
      commandSuggestion: "balchemy runner status --ci --json",
      exitCode: 2,
    });
  }
}

function printHelp(): void {
  reporter.write(`
  ${C.G}B${C.T}alchemy ${C.W}Agent CLI${C.R}  ${C.D}v${CLI_VERSION}${C.R}
  ${C.D}Set up, run and supervise your local Balchemy agents from the terminal.${C.R}

  ${C.W}USAGE${C.R}
    balchemy                         Cockpit: set up your agent and talk to it (one terminal)
    balchemy init                    Choose and explicitly start a local agent
    balchemy runner start <id>       Start the local runner with an agent (shadow mode; it cannot trade)
    balchemy runner status           Runner, version, Hub connection and trading wallet
    balchemy runner wallet <id> create  Create the agent's local encrypted trading wallet
    balchemy runner shutdown         Stop the runner and every agent
    balchemy runner ...              Every runner command: balchemy runner --help
    balchemy doctor                  Read-only checks of Node.js and the terminal
    balchemy doctor --runner         Runner folder, socket, daemon state, versions and Hub connection
    balchemy version                 Show CLI version

  ${C.W}GLOBAL FLAGS${C.R}
    -h, --help                       Show this help
    -v, --version                    Show version
        --json                       Emit valid JSON only; never enters TUI
    -q, --quiet                      Suppress non-essential human output
        --verbose                    Show expanded non-secret details
        --debug                      Show redacted technical details
        --ci                         Non-interactive mode; fail closed on prompts
        --dry-run                    Preview file/action plans without writing
    -y, --yes                        Approves nothing; most commands refuse it
        --force                      Overwrites nothing; most commands refuse it
        --no-color                   Disable ANSI color

  ${C.W}SAFETY${C.R}
    Local entry never starts on blank input.
    Explicit model, rules, chat and pairing actions remain separate. Execution is unavailable.
    JSON and non-TTY entry inspect status only; dry-run does not connect or change files.
    It survives terminal closure while this device stays on; no reboot service is installed.
    --yes never approves live trades, wallet/key mutations, credential deletion, global installs, or file overwrites.
    Use --dry-run before file-writing commands when reviewing changes.

  ${C.W}COCKPIT COMMANDS (type them in the chat input)${C.R}
    /agents /new                     Switch agents (Ctrl+N) or add one; the others keep running as they are
    /pause /stop                     Stop new buys at once (/pause keeps exits running; /stop warns first)
    /resume /arm                     Resume (typed RESUME) and arm (typed ARM and passphrase)
    /limit /budget                   Lower at once; higher opens a card with its typed confirmation
    /directive /model /signals       Strategy (rules card), AI model, launchpad sources
    /status /positions /wallet       State, positions with realized PnL in SOL, address with QR code
    /settings /lang /help /exit      Settings (Ctrl+S), reply language, help (?), leave
    Ctrl+E opens the card · PgUp/PgDn scroll · Ctrl+Q leaves (the runner keeps running)

  ${C.W}REMOVED IN 0.9.0${C.R}
    legacy, start, tui, list, control, agent, auth, config, context and docker belonged to the
    external MCP connection model. Run balchemy instead.

`);
}

async function printRunnerHelp(): Promise<void> {
  // Every arming and exits sentence follows this build's fixed exits capability.
  const { PRIVATE_EXECUTION_CAPABILITIES } = await import("./runner/private-execution-gate.js");
  const exitsAvailable = PRIVATE_EXECUTION_CAPABILITIES.exits === true;
  reporter.write(`
  ${C.G}B${C.T}alchemy ${C.W}local runner${C.R}  ${C.D}v${CLI_VERSION}${C.R}
  ${C.D}A background process on this computer that runs your agents. It stops when this computer restarts or shuts down,
  and does nothing while it sleeps; an unlocked wallet stays unlocked across sleep (lock it with runner wallet <id> lock).${C.R}

  ${C.W}START AND STOP${C.R}
    balchemy runner start <id> [...] Start the runner with these agents (shadow mode; it cannot trade)
    balchemy runner start            Start it again with the agents it already knows (stopped ones stay stopped)
    balchemy runner add <id>         Add an agent to the running runner (shadow mode); other agents keep running, armed or not
    balchemy runner status [id]      Runner, version, Hub connection, trading wallet and each agent
    balchemy runner stop <id>        Stop one agent; the runner keeps running
    balchemy runner shutdown         Stop the runner and every agent (clears unlocked keys from memory)
    balchemy runner recover          Only after a crash or power loss: clean up so it can start again

  ${C.W}SET UP AN AGENT${C.R}
    balchemy runner pair <id> [step] Link the agent to your Hub account (identity only); step is the Challenge ID or confirm
    balchemy runner owner-pin <id>   Seal your Hub wallet and settings on this computer (whole address shown, its last 6 characters, passphrase)
    balchemy runner model <id>       Connect your AI model (key kept in memory; masked)
    balchemy runner model-save <id>  Save the model key encrypted with a passphrase
    balchemy runner model-unlock <id> Unlock the saved model key after a restart
    balchemy runner model-lock <id>  Clear the model key from memory; keep the encrypted copy
    balchemy runner model-status <id> Show the active model and its encrypted storage
    balchemy runner rules <id> <chain> [action]  Private Solana or Base rules
      show | edit | review <proposal-id> | history [before-revision]
      rollback <revision-id> | receipt <operation-id>
      approval off | approval on  (explicit owner setting: off lets an armed agent buy automatically within its caps)
    balchemy runner limits <id> [--daily-calls N]  AI model calls per day (not money; spend caps are under runner wallet <id> limits)
    balchemy runner budget <id> [--daily-usd N]  Daily USD budget for the agent's own AI model cost (default $5; raising asks to confirm)
    balchemy runner sizing <id> [--amount-sol N --slippage-bps N]  Buy size the agent would use
    balchemy runner rpc <id> status | set  Your own Solana RPC (URL at a hidden prompt; shown as host only)
    balchemy runner signals <id> [--launchpads pumpfun,...|none]  Launchpad signal sources (public launches; never a buy by itself)

  ${C.W}TRADING WALLET${C.R}
    balchemy runner wallet <id> <action>  A local encrypted Solana wallet, separate from your Hub wallet
      create | import | unlock | lock | status | recover | bind   (unlock again after every runner start)
      limits [--per-trade SOL|N%|none] [--daily SOL|N%|none]   Optional spend caps (typed confirmation; none = no limit)
      limits review <proposal>   Review a spend cap proposed in chat (same typed confirmation)
      acknowledge-copy   Review and acknowledge a trade signed outside Balchemy (lifts the wallet hold)
    The passphrase cannot be recovered. Only your backed-up secret key restores the wallet.

  ${C.W}LIVE TRADING${C.R}
${exitsAvailable
    ? `    balchemy runner arm <id>         Arm live trading (prechecks, typed ARM <id>, passphrase); CLI-only
      Stop-loss and take-profit exits run only while this computer is on, the runner is running and your wallet is unlocked.`
    : `    balchemy runner arm <id>         Not available in this version: it has no automatic stop-loss exits.
      Arm checks this first and refuses before any other setup check, so your setup was not checked; nothing trades.`}
    balchemy runner disarm <id>      Disarm immediately; no passphrase

  ${C.W}REVIEW${C.R}
    balchemy runner chat <id>        Attach to private assistant jobs
    balchemy runner result <id> <job> Read a private job; does not resubmit it
    balchemy runner decisions <id> [--before N]  Saved signal recommendations
    balchemy runner decision <id> <job-id>       One saved decision; no execution
    balchemy runner trades <id>      Local signed-trade journal; changes nothing
      close <attempt>                Close out a trade held for review after a proof on your own RPC (typed confirmation)
    balchemy runner positions <id>   Local positions, holds and reasons; changes nothing
      resolve <position-id>          Resolve a held position from a proven chain readback (typed confirmation)
      unmanage <reservation-id>      Take a completed buy whose position cannot open off automatic management for good (typed confirmation)
    balchemy runner intent <id> solana preview   Preview an exact owner-entered buy
      show <intent-id>                Read a stored preview; never submit it

  ${C.W}AFTER AN UPGRADE${C.R}
    A running runner keeps its old version. Run balchemy runner shutdown, then balchemy runner start.
    The restart locks your trading wallet and disarms; unlock it again afterwards.

  ${C.W}TROUBLESHOOTING${C.R}
    balchemy doctor --runner         Runner folder, socket, daemon state, versions and Hub connection
    The runner keeps no log file in this version; use runner status, runner trades and doctor --runner.

`);
}

function printVersion(): void {
  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({
      ok: true,
      command: "version",
      version: CLI_VERSION,
      data: { name: "balchemy", version: CLI_VERSION },
    }));
    return;
  }
  reporter.write(`balchemy ${CLI_VERSION}\n`);
}

const KNOWN_COMMANDS = [
  "runner start",
  "runner add",
  "runner status",
  "runner stop",
  "runner arm",
  "runner disarm",
  "runner shutdown",
  "runner recover",
  "runner pair",
  "runner owner-pin",
  "runner model",
  "runner chat",
  "runner result",
  "runner model-lock",
  "runner model-save",
  "runner model-unlock",
  "runner model-status",
  "runner rules",
  "runner intent",
  "runner decisions",
  "runner decision",
  "runner limits",
  "runner budget",
  "runner sizing",
  "runner wallet",
  "runner rpc",
  "runner signals",
  "runner trades",
  "runner positions",
  "init",
  "doctor",
  "version",
];

/**
 * Commands of the external MCP connection model, removed in 0.9.0. A closed list: the message names only
 * the matched entry and never echoes other input.
 */
const REMOVED_COMMANDS = ["legacy", "start", "tui", "list", "control", "agent", "auth", "config", "context", "docker"] as const;

function removedCommandError(first: string | undefined): TerminalError | null {
  const removed = REMOVED_COMMANDS.find((name) => name === first);
  if (!removed) return null;
  return new TerminalError({
    code: "UNKNOWN_COMMAND",
    title: "Command removed",
    cause: `balchemy ${removed} was removed in 0.9.0 together with the external MCP connection.`,
    fix: "Run balchemy to open the cockpit. balchemy runner --help lists the runner commands.",
    commandSuggestion: "balchemy",
    exitCode: 2,
  });
}

function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) matrix[i] = [i];
  for (let j = 0; j <= b.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function suggestCommand(input: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const knownCommand of KNOWN_COMMANDS) {
    const dist = levenshtein(input.toLowerCase(), knownCommand);
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = knownCommand;
    }
  }
  return best;
}

async function runnerDoctorCommand(): Promise<void> {
  if (args.length !== 1) throw new TerminalError({ code: "UNKNOWN_COMMAND", title: "Invalid doctor command", cause: "doctor --runner takes no other arguments.",
    fix: "Run: balchemy doctor --runner", exitCode: 2 });
  const { runnerDoctorChecks } = await import("./runner/commands.js");
  const checks = await runnerDoctorChecks();
  const hasErrors = checks.some((check) => check.status === "error");
  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({ ok: !hasErrors, command: "doctor.runner", version: CLI_VERSION, data: { checks: checks as unknown as JsonValue } }));
  } else {
    reporter.write(`\n  ${C.T}Balchemy runner doctor${C.R} (read-only; nothing was started, stopped or changed)\n`);
    for (const check of checks) {
      const label = check.status === "ok" ? `${C.OK}OK${C.R}` : check.status === "warn" ? `${C.G}WARN${C.R}` : `${C.ERR}ERROR${C.R}`;
      reporter.write(`  ${label.padEnd(18)} ${check.name.padEnd(16)} ${check.detail}\n`);
    }
    reporter.write("\n");
  }
  if (hasErrors) process.exitCode = 2;
}

async function doctorCommand(): Promise<void> {
  if (args[0] === "--runner") { await runnerDoctorCommand(); return; }
  if (args.length > 0) throw new TerminalError({ code: "UNKNOWN_COMMAND", title: "Invalid doctor command",
    cause: "doctor takes no arguments; the agent.config.yaml check was removed in 0.9.0.",
    fix: "Run: balchemy doctor, or balchemy doctor --runner", exitCode: 2 });
  const checks: Array<{ name: string; status: "ok" | "warn" | "error"; detail: string }> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node-version",
    status: nodeMajor >= REQUIRED_NODE_MAJOR ? "ok" : "error",
    detail: `Node ${process.versions.node}; required >=${REQUIRED_NODE_MAJOR}`,
  });
  checks.push({
    name: "terminal",
    status: process.stdout.isTTY ? "ok" : "warn",
    detail: process.stdout.isTTY ? "stdout is interactive" : "stdout is non-interactive; the cockpit and prompts will be blocked",
  });

  const hasErrors = checks.some((check) => check.status === "error");
  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({
      ok: !hasErrors,
      command: "doctor",
      version: CLI_VERSION,
      data: { checks: checks as unknown as JsonValue },
    }));
    if (hasErrors) process.exitCode = 2;
    return;
  }

  reporter.write(`\n  ${C.T}Balchemy CLI doctor${C.R}\n`);
  for (const check of checks) {
    const label = check.status === "ok" ? `${C.OK}OK${C.R}` : check.status === "warn" ? `${C.G}WARN${C.R}` : `${C.ERR}ERROR${C.R}`;
    reporter.write(`  ${label.padEnd(18)} ${check.name.padEnd(16)} ${check.detail}\n`);
  }
  reporter.write("\n");
  if (hasErrors) process.exitCode = 2;
}

async function main(): Promise<void> {
  if (parsed.unknownFlags.length > 0) {
    throw new TerminalError({
      code: "UNKNOWN_FLAG",
      title: "Unknown flag",
      cause: parsed.commandPath[0] === "runner" ? "Unsupported flag for local runner command."
        : `Unsupported flag${parsed.unknownFlags.length > 1 ? "s" : ""}: ${parsed.unknownFlags.join(", ")}`,
      fix: "Remove the unsupported flag or run help to see supported global flags.",
      commandSuggestion: "balchemy --help",
      exitCode: 2,
    });
  }

  if (parsed.flags.help || cmd === "help") {
    if (parsed.commandPath[0] === "runner" || (cmd === "help" && args[0] === "runner")) await printRunnerHelp();
    else printHelp();
    return;
  }
  if (parsed.flags.version || cmd === "version") {
    printVersion();
    return;
  }
  const removed = removedCommandError(parsed.commandPath[0]);
  if (removed) throw removed;

  // The cockpit: `balchemy` alone in a real terminal. Scripts, --json, --dry-run and `balchemy init` keep the read-only overview
  // and the explicit launcher below.
  if (cmd === "" && args.length === 0 && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !parsed.flags.json && !parsed.flags.ci
    && !parsed.flags.quiet && !parsed.flags.dryRun && !parsed.flags.yes && !parsed.flags.force) {
    const { runCockpit } = await import("./cockpit/cockpit-flow.js");
    const { createCockpitDeps } = await import("./cockpit/cockpit-runtime.js");
    const { runnerDirectory } = await import("./runner/lifecycle.js");
    await runCockpit(createCockpitDeps(runnerDirectory(), process.env.BALCHEMY_WEB_ORIGIN ?? "https://balchemy.ai"));
    return;
  }
  if (cmd === "" || cmd === "init") {
    const { runLocalEntry } = await import("./local-entry.js");
    const result = await runLocalEntry({ args, flags: parsed.flags,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      write: (text) => { if (!parsed.flags.quiet) process.stdout.write(text); } });
    if (result.kind !== "route") {
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd || "local",
        version: CLI_VERSION, data: result as unknown as JsonValue }));
      return;
    }
    // The launcher closes its input before the selected handler owns the terminal.
    cmd = result.command; args = result.args;
    parsed.commandPath = cmd.split(" "); parsed.args = args;
  }

  switch (cmd) {
    case "runner arm": {
      const { runPrivateArmCommand, formatPrivateArmResult } = await import("./runner/private-arming-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      // Real terminal, closed prechecks, typed ARM <agent> and the re-entered passphrase; the server and Hub can never arm.
      // A2a: an unsealed Hub wallet or settings opens the seal step inline (runner owner-pin), then the checks run again.
      const { runPrivateOwnerPinSeal, formatPrivateOwnerPinResult } = await import("./runner/private-owner-pin-ui.js");
      const { readSetupRulesReview } = await import("./cockpit/cockpit-setup.js");
      const { createWalletPrompt, guardTerminalSignals } = await import("./runner/private-trading-keystore-ui.js");
      const { readPrivateBrainTarget } = await import("./runner/private-brain-client.js");
      const directory = runnerDirectory();
      const sealAuthority = async (known?: string): Promise<boolean> => {
        const prompt = createWalletPrompt(); const release = guardTerminalSignals(() => prompt.close());
        try {
          const result = await runPrivateOwnerPinSeal({ target: readPrivateBrainTarget(directory, args[0]!), write, prompt,
            describeRules: (agentId, revisionId) => readSetupRulesReview(directory, agentId, revisionId), ...(known !== undefined ? { known } : {}),
            reason: "Before arming: your Hub wallet or your settings are not sealed on this computer (or a setting is now looser than your seal)." });
          await write(formatPrivateOwnerPinResult(result));
          return result.kind === "sealed";
        } catch { return false; } finally { release(); prompt.close(); }
      };
      const result = await runPrivateArmCommand({ args, flags: parsed.flags, directory,
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write, sealAuthority });
      await write(formatPrivateArmResult(result));
      if (result.kind !== "armed" && result.kind !== "dry_run") process.exitCode = 1;
      return;
    }
    case "runner owner-pin": {
      const { runPrivateOwnerPinCommand, formatPrivateOwnerPinResult } = await import("./runner/private-owner-pin-ui.js");
      const { readSetupRulesReview } = await import("./cockpit/cockpit-setup.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      const directory = runnerDirectory();
      // Real terminal only: the whole Hub wallet address to compare, its typed last 6 characters, then the hidden wallet passphrase.
      const result = await runPrivateOwnerPinCommand({ args, flags: parsed.flags, directory, interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write,
        describeRules: (agentId, revisionId) => readSetupRulesReview(directory, agentId, revisionId) });
      await write(formatPrivateOwnerPinResult(result));
      if (result.kind !== "sealed" && result.kind !== "dry_run") process.exitCode = 1;
      return;
    }
    case "runner wallet": {
      if (args[1] === "limits") {
        const { runPrivateSpendLimitsCommand, formatPrivateSpendLimitsResult } = await import("./runner/private-arming-ui.js");
        const { runnerDirectory } = await import("./runner/lifecycle.js");
        const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
          process.stdout.write(text, (error) => error ? reject(error) : resolve());
        });
        const result = await runPrivateSpendLimitsCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
        const ok = result.kind !== "outcome_unknown";
        if (parsed.flags.json) reporter.json(jsonEnvelope({ ok, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
        else await write(formatPrivateSpendLimitsResult(result));
        if (!ok) process.exitCode = 1;
        return;
      }
      if (args[1] === "acknowledge-copy") {
        const { runPrivateCopyAcknowledgement, formatPrivateCopyAcknowledgementResult } = await import("./runner/private-submission-ui.js");
        const { runnerDirectory } = await import("./runner/lifecycle.js");
        const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
          process.stdout.write(text, (error) => error ? reject(error) : resolve());
        });
        // Real terminal + typed confirmation only; it lifts the hold and changes no trade, ledger entry or key.
        const result = await runPrivateCopyAcknowledgement({ args, flags: parsed.flags, directory: runnerDirectory(),
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
        await write(formatPrivateCopyAcknowledgementResult(result));
        if (result.kind === "outcome_unknown") process.exitCode = 1;
        return;
      }
      const { runPrivateTradingWalletCommand, formatPrivateTradingWalletResult } = await import("./runner/private-trading-keystore-ui.js");
      const { privateRuleJson } = await import("./runner/private-rule-commands.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      // Deliberate owner output: a one-time secret display and exact public addresses,
      // never generic logging. The secret itself is never part of the result.
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      const result = await runPrivateTradingWalletCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
      const ok = result.kind !== "outcome_unknown";
      await write(parsed.flags.json ? `${privateRuleJson(jsonEnvelope({ ok, command: cmd, version: CLI_VERSION,
        data: result as unknown as JsonValue }))}\n` : formatPrivateTradingWalletResult(result));
      if (!ok) process.exitCode = 1;
      return;
    }
    case "runner rpc": {
      const { runPrivateSolanaRpcCommand, formatPrivateSolanaRpcResult } = await import("./runner/private-solana-rpc-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      // The endpoint URL is read only at the hidden prompt, never from argv; results and errors carry its host alone.
      const result = await runPrivateSolanaRpcCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
      const ok = result.kind !== "outcome_unknown";
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
      else await write(formatPrivateSolanaRpcResult(result, args[0]!));
      if (!ok) process.exitCode = 1;
      return;
    }
    case "runner trades": {
      const { runPrivateSubmissionCommand, formatPrivateSubmissionResult, runPrivateTradeClose, formatPrivateTradeCloseResult,
        CLOSE_TRADE_ACTION } = await import("./runner/private-submission-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      if (args[1] === CLOSE_TRADE_ACTION) {
        const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
          process.stdout.write(text, (error) => error ? reject(error) : resolve());
        });
        // Owner decision 26: real terminal + typed confirmation only; the daemon proves on the owner's own RPC before it closes anything.
        const result = await runPrivateTradeClose({ args, flags: parsed.flags, directory: runnerDirectory(),
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
        await write(formatPrivateTradeCloseResult(result));
        if (result.kind === "outcome_unknown" || result.kind === "refused") process.exitCode = 1;
        return;
      }
      // Public journal facts only; wire bytes, keys and proofs never reach the CLI.
      const result = await runPrivateSubmissionCommand({ args, flags: parsed.flags, directory: runnerDirectory() });
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
      else reporter.write(formatPrivateSubmissionResult(result));
      return;
    }
    case "runner positions": {
      const { runPrivatePositionCommand, formatPrivatePositionResult, runPrivatePositionResolve, formatPrivatePositionResolveResult,
        RESOLVE_POSITION_ACTION, runPrivatePositionUnmanage, formatPrivatePositionUnmanageResult, UNMANAGE_POSITION_ACTION } = await import("./runner/private-position-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      if (args[1] === UNMANAGE_POSITION_ACTION) {
        const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
          process.stdout.write(text, (error) => error ? reject(error) : resolve());
        });
        // Owner item 75: real terminal + typed confirmation; one ledger write after the runner's eligibility checks. Nothing is
        // signed, sent or sold, and it cannot be undone.
        const result = await runPrivatePositionUnmanage({ args, flags: parsed.flags, directory: runnerDirectory(),
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
        await write(formatPrivatePositionUnmanageResult(result));
        if (result.kind === "outcome_unknown" || result.kind === "unchanged") process.exitCode = 1;
        return;
      }
      if (args[1] === RESOLVE_POSITION_ACTION) {
        const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
          process.stdout.write(text, (error) => error ? reject(error) : resolve());
        });
        // Real terminal + typed confirmation; one ledger write on a proven chain readback. Nothing is signed, sent or sold.
        const result = await runPrivatePositionResolve({ args, flags: parsed.flags, directory: runnerDirectory(),
          interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
        await write(formatPrivatePositionResolveResult(result));
        if (result.kind === "outcome_unknown" || result.kind === "unchanged") process.exitCode = 1;
        return;
      }
      // Public ledger facts only; keys, wire bytes, proofs and RPC URLs never reach the CLI.
      const result = await runPrivatePositionCommand({ args, flags: parsed.flags, directory: runnerDirectory() });
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
      else reporter.write(formatPrivatePositionResult(result));
      return;
    }
    case "runner signals": {
      const { runPrivateLaunchpadCommand, formatPrivateLaunchpadResult } = await import("./runner/private-launchpad-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const { terminalSocketProofSecret } = await import("./runner/private-socket-proof-client.js");
      // A2a: adding a source may ask the trading wallet passphrase (raw-mode hidden prompt, only in a real terminal).
      const result = await runPrivateLaunchpadCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        proofSecret: terminalSocketProofSecret(Boolean(process.stdin.isTTY && process.stdout.isTTY) && !parsed.flags.json && !parsed.flags.ci) });
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
      else reporter.write(formatPrivateLaunchpadResult(result, args[0]!));
      return;
    }
    case "runner sizing": {
      const { runPrivateSizingCommand, formatPrivateSizingResult } = await import("./runner/private-sizing-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      const result = await runPrivateSizingCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
      const ok = result.kind !== "outcome_unknown";
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
      else await write(formatPrivateSizingResult(result, args[0]!));
      if (!ok) process.exitCode = 1;
      return;
    }
    case "runner limits": {
      const { runPrivateAutonomyCommand, formatPrivateAutonomyResult } = await import("./runner/private-autonomy-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const { terminalSocketProofSecret } = await import("./runner/private-socket-proof-client.js");
      // A2a: a higher daily call limit may ask the trading wallet passphrase (raw-mode hidden prompt, only in a real terminal).
      const result = await runPrivateAutonomyCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        proofSecret: terminalSocketProofSecret(Boolean(process.stdin.isTTY && process.stdout.isTTY) && !parsed.flags.json && !parsed.flags.ci) });
      const ok = result.kind !== "outcome_unknown";
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
      else reporter.write(formatPrivateAutonomyResult(result, args[0]!));
      if (!ok) process.exitCode = 1;
      return;
    }
    case "runner budget": {
      const { runPrivateModelBudgetCommand, formatPrivateModelBudgetResult } = await import("./runner/private-model-budget-ui.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      const result = await runPrivateModelBudgetCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
      const ok = result.kind !== "outcome_unknown" && result.kind !== "cancelled";
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok, command: cmd, version: CLI_VERSION, data: result as unknown as JsonValue }));
      else await write(formatPrivateModelBudgetResult(result, args[0]!));
      if (!ok) process.exitCode = 1;
      return;
    }
    case "runner decisions":
    case "runner decision": {
      const { runPrivateSignalCommand, formatPrivateSignalResult } = await import("./runner/private-signal-ui.js");
      const { privateRuleJson } = await import("./runner/private-rule-commands.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const result = await runPrivateSignalCommand({ action: cmd === "runner decisions" ? "list" : "read",
        args, flags: parsed.flags, directory: runnerDirectory() });
      const output = parsed.flags.json ? `${privateRuleJson(jsonEnvelope({ ok: true, command: cmd,
        version: CLI_VERSION, data: result as unknown as JsonValue }))}\n` : formatPrivateSignalResult(result, args[0]!);
      await new Promise<void>((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
      return;
    }
    case "runner intent": {
      const { runPrivateIntentCommand, formatPrivateIntentResult } = await import("./runner/private-intent-commands.js");
      const { privateRuleJson } = await import("./runner/private-rule-commands.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      const result = await runPrivateIntentCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
      const ok = result.kind !== "outcome_unknown" && result.kind !== "not_found";
      await write(parsed.flags.json ? `${privateRuleJson(jsonEnvelope({ ok, command: cmd, version: CLI_VERSION,
        data: result as unknown as JsonValue }))}\n` : formatPrivateIntentResult(result));
      if (!ok) process.exitCode = 1;
      return;
    }
    case "runner rules": {
      const { runPrivateRuleCommand, formatRuleCommandResult, privateRuleJson } = await import("./runner/private-rule-commands.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      // Explicit local rule review must preserve exact source and identifiers.
      // The general log redactor changes addresses; these validated documents
      // use deliberate owner output, never generic logging or telemetry.
      const write = (text: string): Promise<void> => new Promise((resolve, reject) => {
        process.stdout.write(text, (error) => error ? reject(error) : resolve());
      });
      const result = await runPrivateRuleCommand({ args, flags: parsed.flags, directory: runnerDirectory(),
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), write });
      await write(parsed.flags.json ? `${privateRuleJson(jsonEnvelope({ ok: result.kind !== "outcome_unknown" && result.kind !== "review_blocked", command: cmd,
        version: CLI_VERSION, data: result as unknown as JsonValue }))}\n` : formatRuleCommandResult(result));
      if (result.kind === "outcome_unknown") process.exitCode = 1;
      else if (result.kind === "review_blocked") process.exitCode = 2;
      return;
    }
    case "runner model":
    case "runner chat":
    case "runner model-lock":
    case "runner model-save":
    case "runner model-unlock":
    case "runner model-status":
    case "runner result": {
      const action = parsed.commandPath[1] as "model" | "chat" | "model-lock" | "model-save" | "model-unlock" | "model-status" | "result";
      if (args.length !== (action === "result" ? 2 : 1) || args.some((value) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) || parsed.flags.force) {
        throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid private assistant command",
          cause: "Use one explicit local agent ID and, for result, one job ID. Keys, message text, extra arguments and --force are not accepted.",
          fix: "Run balchemy --help for usage. Configure keys only in the masked interactive prompt.", exitCode: 2 });
      }
      if (parsed.flags.dryRun) {
        const data = { action, agentId: args[0]!, ...(action === "result" ? { jobId: args[1]! } : {}), preview: true };
        if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION, data }));
        else reporter.write(`Private assistant ${action} preview for ${args[0]}. No connection, prompt or change made.\n`);
        return;
      }
      if (action !== "result" && action !== "model-status") ensureInteractive(`balchemy runner ${action}`);
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      const { readPrivateBrainTarget } = await import("./runner/private-brain-client.js");
      const { privateBrainErrorMessage, privateResultLines, readPrivateResult, readPrivateModelStatus, privateModelSummary, privateVaultSummary } = await import("./runner/private-brain-ui.js");
      let target;
      try { target = readPrivateBrainTarget(runnerDirectory(), args[0]!); }
      catch {
        const { knownRunnerAgents, runnerNotRunningError } = await import("./runner/not-running.js");
        throw runnerNotRunningError(args[0], knownRunnerAgents(runnerDirectory()), "Local assistant unavailable");
      }
      if (action === "model-status") {
        let response;
        try { response = await readPrivateModelStatus(target); }
        catch { throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local model status unavailable", cause: "This read did not confirm the current model or encrypted storage.",
          fix: "Inspect runner status. No credentials were changed.", exitCode: 1 }); }
        if (!response.ok) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local model status unavailable", cause: privateBrainErrorMessage(response.error),
          fix: "Inspect runner status. No credentials were changed.", exitCode: 1 });
        if (!response.model) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid model status", cause: "The reply did not contain model state.", fix: "Inspect runner status.", exitCode: 1 });
        if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION,
          data: { agentId: target.agentId, model: response.model, vault: response.vault } }));
        else reporter.write(`${privateModelSummary(response.model)}\n${privateVaultSummary(response.vault)}\n`);
      } else if (action === "result") {
        let response;
        try { response = await readPrivateResult(target, args[1]!); }
        catch { throw new TerminalError({ code: "RUNTIME_OUTCOME_UNKNOWN", title: "Local result unavailable",
          cause: "This read did not confirm the job outcome. No job was created or cancelled.", fix: "Keep the same agent and job IDs; inspect runner status before reading again.", exitCode: 1 }); }
        if (!response.ok) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Local result not confirmed", cause: privateBrainErrorMessage(response.error),
          fix: "Keep the job ID and inspect the current local runner.", exitCode: 1 });
        if (!response.job) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Invalid local result", cause: "The reply did not contain the requested job.", fix: "Keep the job ID.", exitCode: 1 });
        if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION, data: { agentId: target.agentId, job: response.job as unknown as JsonValue } }));
        else reporter.write(`${privateResultLines(response.job).join("\n")}\n`);
      } else {
        const { startLocalRunnerChat } = await import("./tui/LocalRunnerChat.js");
        await startLocalRunnerChat(target, action);
      }
      return;
    }
    case "runner pair": {
      const { runPairingCommand, isPairingConfirmation, pairingApprovalDetails } = await import("./runner/pairing-workflow.js");
      const { runnerDirectory } = await import("./runner/lifecycle.js");
      if (!parsed.flags.dryRun && args[1] && args[1] !== "confirm") ensureInteractive("balchemy runner pair approval");
      const data = await runPairingCommand({
        directory: runnerDirectory(), frontendOrigin: process.env.BALCHEMY_WEB_ORIGIN ?? "https://balchemy.ai",
        args, dryRun: parsed.flags.dryRun,
        approve: async (preview) => {
          ensureInteractive("balchemy runner pair approval");
          // Only validated public binding fields enter this approval screen.
          // The generic log redactor hides EVM addresses; an exact wallet must
          // instead remain visible in this deliberate ownership decision.
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          try {
            const details = pairingApprovalDetails(preview);
            return isPairingConfirmation(await ask(rl, details), preview.challengeId);
          } finally { rl.close(); }
        },
      });
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION, data: data as unknown as JsonValue }));
      else {
        if (data.state === "awaiting_browser") {
          reporter.write(`Open this pairing link in your browser:\n${data.url}\nRunner fingerprint: ${data.runnerFingerprint.match(/.{1,8}/g)?.join(" ")}\n`);
          reporter.write(`In the browser, choose your verified wallet. Hub then shows a Challenge ID.\nRun: balchemy runner pair ${args[0]} <paste the Challenge ID>\n`);
        } else if (data.state === "awaiting_wallet") {
          reporter.write(`Paste this single-purpose proof into the pairing page:\n${JSON.stringify(data.proof)}\n`);
          reporter.write(`After browser confirmation, run: balchemy runner pair ${args[0]} confirm\n`);
        } else if (data.state === "paired") reporter.write([`Paired. ${args[0]} is linked to your Hub account (agent ${data.agentId}; identity only, no trading).`,
          `Next: connect your AI model with balchemy runner model ${args[0]}, then create a trading wallet with balchemy runner wallet ${args[0]} create.`,
          "Once that wallet is unlocked, the runner links it to your Hub account by itself (nothing to type).", ""].join("\n"));
        else if (data.state === "cancelled") reporter.write("Pairing cancelled before local approval.\n");
        else reporter.write(`Pairing ${data.action} preview; no files or requests created.\n`);
      }
      return;
    }
    case "runner":
    case "runner start":
    case "runner add":
    case "runner status":
    case "runner stop":
    case "runner disarm":
    case "runner recover":
    case "runner shutdown": {
      if (parsed.flags.force) throw new TerminalError({ code: "RUNTIME_ERROR", title: "Force is not supported for local runners",
        cause: "Local runner ownership must be proven before recovery.", fix: "Remove --force. Keep local coordination and state files intact.", exitCode: 2 });
      if (parsed.flags.yes && parsed.commandPath[1] !== undefined) throw new TerminalError({ code: "UNKNOWN_FLAG", title: "Unsupported flag",
        cause: parsed.commandPath[1] === "shutdown"
          ? "--yes is not supported by balchemy runner shutdown: while an agent is armed or holds open positions, a shutdown needs the typed SHUTDOWN in a terminal."
          : `--yes is not supported by balchemy runner ${parsed.commandPath[1]}; nothing here needs an approval prompt.`,
        fix: "Remove --yes and run the command again.", commandSuggestion: "balchemy runner --help", exitCode: 2 });
      const { runRunnerCommand, formatRunnerStatus, confirmRunnerShutdown } = await import("./runner/commands.js");
      // Phase 1: a shutdown that leaves positions without stop-loss asks for the typed SHUTDOWN, only in a real terminal.
      const data = await runRunnerCommand(parsed.commandPath[1] ?? "", args, parsed.flags.dryRun, {
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !parsed.flags.json && !parsed.flags.ci, confirm: confirmRunnerShutdown });
      if (parsed.flags.json) reporter.json(jsonEnvelope({ ok: true, command: cmd, version: CLI_VERSION, data }));
      else reporter.write(await formatRunnerStatus(parsed.commandPath[1] ?? "", data, { dryRun: parsed.flags.dryRun }));
      return;
    }
    case "doctor":
      await doctorCommand();
      return;
    default: {
      const suggestion = suggestCommand(cmd || (parsed.commandPath[0] ?? ""));
      throw new TerminalError({
        code: "UNKNOWN_COMMAND",
        title: "Unknown command",
        cause: `Unknown command: ${cmd || parsed.commandPath.join(" ")}`,
        fix: suggestion ? `Did you mean balchemy ${suggestion}?` : "Run balchemy --help for available commands.",
        commandSuggestion: suggestion ? `balchemy ${suggestion}` : "balchemy --help",
        exitCode: 2,
      });
    }
  }
}

main().catch((err: unknown) => {
  const terminalError = toTerminalError(err);
  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({
      ok: false,
      command: cmd || "root",
      version: CLI_VERSION,
      error: terminalErrorToJson(terminalError),
    }));
  } else {
    renderTerminalError(reporter, terminalError);
  }
  process.exit(terminalError.exitCode);
});
