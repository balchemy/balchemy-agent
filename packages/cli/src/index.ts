#!/usr/bin/env node
/**
 * balchemy CLI entry point.
 *
 * Public terminal surface for setup, local agent context, config validation,
 * Docker file generation, and the Ink cockpit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { AgentLoopConfig } from "@balchemyai/agent-sdk";
import {
  clearAgent,
  getStorePath,
  listAgents,
  loadAgent,
  setActiveAgent,
  type StoredAgent,
} from "./agent-store.js";
import { C, setNoColor } from "./colors.js";
import {
  commandKey,
  isNonInteractive,
  parseCliArgs,
  type CliFlags,
} from "./cli-options.js";
import {
  compactValue,
  createReporter,
  endpointHost,
  jsonEnvelope,
  redactJsonValue,
  type JsonValue,
} from "./output.js";
import {
  renderTerminalError,
  terminalErrorToJson,
  TerminalError,
  toTerminalError,
} from "./errors.js";

const require = createRequire(import.meta.url);
const CLI_VERSION = (require("../package.json") as { version?: string }).version ?? "unknown";
const parsed = parseCliArgs(process.argv.slice(2));

if (parsed.flags.noColor) {
  setNoColor();
}

const reporter = createReporter(parsed.flags);
const cmd = commandKey(parsed.commandPath);
const args = parsed.args;

function ask(rl: readline.Interface, question: string, defaultVal = ""): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` ${C.D}[${defaultVal}]${C.R}` : "";
    rl.question(`  ${C.T}${question}${C.R}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function normalizeChoice(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (/^([0-9a-z])\1+$/.test(trimmed)) {
    return trimmed[0] ?? trimmed;
  }
  return trimmed;
}

function printSummaryBlock(title: string, rows: Array<{ label: string; value: string }>): void {
  const maxLabel = rows.reduce((acc, row) => Math.max(acc, row.label.length), 0);
  reporter.write(`  ${C.T}${title}${C.R}\n`);
  for (const row of rows) {
    reporter.write(`  ${C.D}${row.label.padEnd(maxLabel)}${C.R}  ${row.value}\n`);
  }
  reporter.write(`  ${C.D}${"-".repeat(54)}${C.R}\n`);
}

function mostRecentAgent(agents: StoredAgent[]): StoredAgent | null {
  if (agents.length === 0) return null;
  return [...agents].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  })[0] ?? null;
}

function ensureInteractive(commandName: string): void {
  if (parsed.flags.json) {
    throw new TerminalError({
      code: "TERMINAL_UNSUPPORTED_TUI",
      title: "Interactive terminal required",
      cause: `${commandName} launches an interactive TUI and cannot run with --json.`,
      fix: "Use a plain CLI command for automation, such as balchemy config validate --json or balchemy agent current --json.",
      commandSuggestion: "balchemy doctor --json",
      exitCode: 2,
    });
  }
  if (parsed.flags.ci || !process.stdin.isTTY || !process.stdout.isTTY) {
    throw new TerminalError({
      code: parsed.flags.ci ? "CI_PROMPT_BLOCKED" : "TERMINAL_UNSUPPORTED_TUI",
      title: "Interactive terminal required",
      cause: `${commandName} needs a TTY, but this session is non-interactive.`,
      fix: "Run the command in a terminal, or use non-interactive validation commands in CI.",
      commandSuggestion: "balchemy config validate --ci --json",
      exitCode: 2,
    });
  }
}

async function startSavedAgent(agent: StoredAgent): Promise<void> {
  ensureInteractive("balchemy start");
  setActiveAgent(agent.publicId);
  const { startTui } = await import("./tui/start.js");
  await startTui({
    mcpEndpoint: agent.mcpEndpoint,
    apiKey: agent.apiKey,
    llmProvider: agent.llmProvider,
    llmApiKey: agent.llmApiKey,
    llmModel: agent.llmModel,
    llmBaseUrl: agent.llmBaseUrl,
    maxDailyLlmCost: agent.maxDailyLlmCost,
    llmTimeoutMs: agent.llmTimeoutMs,
    publicId: agent.publicId,
    strategy: agent.strategy,
    shadowMode: agent.shadowMode,
    behaviorRules: agent.behaviorRules,
    autoSeedSubscriptions: false,
  });
}

async function runWizardFromCwd(): Promise<void> {
  ensureInteractive("balchemy init");
  const { startWizard } = await import("./tui/start-wizard.js");
  await startWizard(process.cwd());
}

async function chooseSavedAgent(
  rl: readline.Interface,
  agents: StoredAgent[],
): Promise<StoredAgent | null> {
  const rows = agents.map((agent, index) => ({
    label: String(index + 1),
    value: `${compactValue(agent.publicId, 18, 6)}  ${compactValue(agent.mcpEndpoint, 34, 10)}`,
  }));
  printSummaryBlock("Saved agents", rows);
  const answer = normalizeChoice(await ask(rl, `${C.W}Choose agent number or publicId${C.R}`, "1"));
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= agents.length) {
    return agents[index - 1] ?? null;
  }
  return agents.find((agent) => agent.publicId.toLowerCase() === answer) ?? null;
}

function parseSemver(value: string): [number, number, number] | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function isNewerVersion(latest: string, current: string): boolean {
  const latestParts = parseSemver(latest);
  const currentParts = parseSemver(current);
  if (!latestParts || !currentParts) return latest !== current;
  for (let index = 0; index < latestParts.length; index += 1) {
    if (latestParts[index] > currentParts[index]) return true;
    if (latestParts[index] < currentParts[index]) return false;
  }
  return false;
}

function shouldCheckForUpdate(flags: CliFlags): boolean {
  if (flags.json || flags.ci || flags.help || flags.version || isNonInteractive(flags)) return false;
  return cmd === "" || cmd === "init" || cmd === "start";
}

async function checkForUpdate(flags: CliFlags): Promise<void> {
  if (!shouldCheckForUpdate(flags)) return;

  try {
    const res = await fetch("https://registry.npmjs.org/balchemy/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest || !isNewerVersion(latest, CLI_VERSION)) return;

    reporter.warn(`\n  ${C.G}Update available${C.R} ${C.D}${CLI_VERSION}${C.R} → ${C.T}${latest}${C.R}\n`);
    reporter.warn(`  ${C.D}Run ${C.W}npm install -g balchemy@${latest}${C.D} yourself if you want to update.${C.R}\n\n`);
  } catch {
    return;
  }
}

function printHelp(): void {
  reporter.write(`
  ${C.G}B${C.T}alchemy ${C.W}Agent CLI${C.R}  ${C.D}v${CLI_VERSION}${C.R}
  ${C.D}Create, inspect, run, and safely supervise Balchemy agents from the terminal.${C.R}

  ${C.W}USAGE${C.R}
    balchemy                         Resume saved agent or run setup wizard
    balchemy init                    Run setup wizard
    balchemy start [config]          Start the live Ink cockpit
    balchemy list                    List saved agents
    balchemy control status          Show backend autonomous runtime mode
    balchemy control pause           Pause backend autonomous runtime
    balchemy control resume          Resume in unarmed mode
    balchemy control arm             Arm live autonomous execution
    balchemy control disarm          Return live runtime to unarmed mode
    balchemy docker [outDir]         Generate Docker files

  ${C.W}COMMANDS${C.R}
    agent list                       List saved agents (alias: list)
    agent current                    Show active agent context
    agent use <publicId>             Switch active saved agent
    agent control <action>           Alias for control <action>
    auth status                      Show local auth/context status
    auth login                       Run interactive setup wizard (alias: init)
    auth logout                      Clear active context; credential removal stays explicit
    context current                  Show active agent context (alias: agent current)
    config validate [config]         Validate config and env references
    config list [config]             Show non-secret effective config
    doctor [config]                  Run read-only local CLI checks
    version                          Show CLI version

  ${C.W}GLOBAL FLAGS${C.R}
    -h, --help                       Show this help
    -v, --version                    Show version
        --json                       Emit valid JSON only; never enters TUI
    -q, --quiet                      Suppress non-essential human output
        --verbose                    Show expanded non-secret details
        --debug                      Show redacted technical details
        --ci                         Non-interactive mode; fail closed on prompts
        --dry-run                    Preview file/action plans without writing
    -y, --yes                        Approve safe non-overwrite prompts only
        --force                      Allow explicit local file overwrites
        --no-color                   Disable ANSI color

  ${C.W}SAFETY${C.R}
    --yes never approves live trades, wallet/key mutations, credential deletion, global installs, or file overwrites.
    Use --dry-run before file-writing commands when reviewing changes.

  ${C.W}SHORTCUTS (cockpit)${C.R}
    Ctrl+S                           Open settings
    Ctrl+L                           Clear chat
    Ctrl+N                           Switch agent
    Ctrl+O                           Export redacted activity transcript
    Ctrl+Q                           Quit
    PgUp / PgDn                      Scroll chat history
    Esc in TRADE CHECK               Cancel; never approve
    Esc                              Back, close overlay, or cancel
    ?                                Keyboard help overlay when available

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
  "init",
  "start",
  "docker",
  "list",
  "control",
  "control status",
  "control pause",
  "control resume",
  "control arm",
  "control disarm",
  "control set-mode",
  "agent list",
  "agent current",
  "agent use",
  "agent control",
  "auth status",
  "config validate",
  "config list",
  "doctor",
  "version",
  "context current",
  "context status",
  "tui",
  "auth login",
  "auth logout",
];

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

function agentToJson(agent: StoredAgent, activePublicId: string | null): JsonValue {
  return {
    publicId: agent.publicId,
    active: activePublicId === agent.publicId,
    name: agent.name ?? null,
    endpointHost: endpointHost(agent.mcpEndpoint),
    mcpEndpoint: agent.mcpEndpoint,
    llmProvider: agent.llmProvider,
    llmModel: agent.llmModel ?? null,
    mode: agent.shadowMode ? "shadow" : "live",
    strategy: agent.strategy,
    createdAt: agent.createdAt,
    credentials: {
      apiKey: "[redacted]",
      llmApiKey: "[redacted]",
      redacted: true,
    },
  };
}

function agentListData(): JsonValue {
  const agents = listAgents();
  const active = loadAgent();
  return {
    activePublicId: active?.publicId ?? null,
    storePath: getStorePath(),
    agents: agents.map((agent) => agentToJson(agent, active?.publicId ?? null)),
  };
}

function printAgentList(commandName: string): void {
  const agents = listAgents();
  const active = loadAgent();

  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({
      ok: true,
      command: commandName,
      version: CLI_VERSION,
      data: agentListData(),
    }));
    return;
  }

  if (agents.length === 0) {
    reporter.write(`  ${C.D}No saved agents. Run ${C.W}balchemy init${C.D} to create one or ${C.W}balchemy auth status${C.D} to inspect context.${C.R}\n`);
    return;
  }

  reporter.write(`\n  ${C.T}Saved agents${C.R} ${C.D}(${agents.length})${C.R}\n`);
  reporter.write(`  ${C.D}${"-".repeat(54)}${C.R}\n`);

  for (const agent of agents) {
    const isActive = active?.publicId === agent.publicId;
    const marker = isActive ? `${C.OK}>${C.R}` : " ";
    const id = compactValue(agent.publicId, 20, 8);
    const endpoint = compactValue(agent.mcpEndpoint, 30, 10);
    const model = agent.llmModel ?? "default";
    const mode = agent.shadowMode ? `${C.G}shadow${C.R}` : `${C.OK}live-approved${C.R}`;

    reporter.write(`  ${marker} ${C.W}${id}${C.R}\n`);
    reporter.write(`    ${C.D}Endpoint${C.R}  ${endpoint}\n`);
    reporter.write(`    ${C.D}Host${C.R}      ${endpointHost(agent.mcpEndpoint)}\n`);
    reporter.write(`    ${C.D}Model${C.R}     ${model}  ${mode}\n`);
    reporter.write(`    ${C.D}Created${C.R}   ${agent.createdAt}\n`);
    reporter.write(`  ${C.D}${"-".repeat(54)}${C.R}\n`);
  }
  reporter.write(`\n  ${C.D}Next${C.R} ${C.W}balchemy start${C.R} ${C.D}or${C.R} ${C.W}balchemy agent use <publicId>${C.R}\n\n`);
}

function printAgentCurrent(): void {
  const active = loadAgent();
  const data: JsonValue = {
    active: active ? agentToJson(active, active.publicId) : null,
    hasActiveAgent: Boolean(active),
    storePath: getStorePath(),
  };

  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({ ok: true, command: "agent.current", version: CLI_VERSION, data }));
    return;
  }

  if (!active) {
    reporter.write(`  ${C.D}No active agent. Run ${C.W}balchemy list${C.D} or ${C.W}balchemy init${C.D}.${C.R}\n`);
    return;
  }

  printSummaryBlock("Active agent", [
    { label: "Agent", value: active.publicId },
    { label: "Endpoint", value: compactValue(active.mcpEndpoint, 42, 12) },
    { label: "Host", value: endpointHost(active.mcpEndpoint) },
    { label: "Provider", value: active.llmProvider },
    { label: "Model", value: active.llmModel ?? "default" },
    { label: "Mode", value: active.shadowMode ? "Shadow" : "Live-approved" },
    { label: "Saved", value: active.createdAt },
    { label: "Secrets", value: "stored encrypted locally, redacted in CLI output" },
  ]);
}

type ControlAction = "status" | "pause" | "resume" | "arm" | "disarm" | "set_mode";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeControlAction(commandName: string, commandArgs: string[]): { action: ControlAction; mode?: string } {
  const commandPart = commandName.startsWith("control ") ? commandName.slice("control ".length) : "";
  const raw = (commandPart || commandArgs[0] || "status").replace("-", "_").toLowerCase();
  if (raw === "set_mode") {
    const mode = commandArgs[0] && commandPart ? commandArgs[0] : commandArgs[1];
    if (!mode) {
      throw new TerminalError({
        code: "UNKNOWN_COMMAND",
        title: "Missing runtime mode",
        cause: "balchemy control set-mode requires a target mode.",
        fix: "Use one of: shadow, live_unarmed, live_armed, paused.",
        commandSuggestion: "balchemy control set-mode shadow",
        exitCode: 2,
      });
    }
    return { action: "set_mode", mode };
  }
  if (raw === "status" || raw === "pause" || raw === "resume" || raw === "arm" || raw === "disarm") {
    return { action: raw };
  }
  throw new TerminalError({
    code: "UNKNOWN_COMMAND",
    title: "Unknown control action",
    cause: `Unsupported control action: ${raw || "(empty)"}.`,
    fix: "Use status, pause, resume, arm, disarm, or set-mode.",
    commandSuggestion: "balchemy control status",
    exitCode: 2,
  });
}

async function mcpToolCall(
  endpoint: string,
  apiKey: string,
  name: string,
  toolArgs: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const nonce = `cli-${Date.now()}-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${apiKey}`,
      "x-request-nonce": nonce,
      "x-request-timestamp": timestamp,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: toolArgs,
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const raw = await response.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  const jsonText = dataLine ? dataLine.slice(6) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new TerminalError({
      code: "RUNTIME_ERROR",
      title: "Invalid MCP response",
      cause: `MCP returned a non-JSON response with HTTP ${response.status}.`,
      fix: "Check the endpoint and API key, then retry with --debug if needed.",
      commandSuggestion: "balchemy auth status",
      exitCode: 1,
    });
  }

  if (!isRecord(parsed)) {
    throw new TerminalError({
      code: "RUNTIME_ERROR",
      title: "Invalid MCP response",
      cause: "MCP returned an unexpected response envelope.",
      fix: "Check the endpoint and API key, then retry.",
      commandSuggestion: "balchemy auth status",
      exitCode: 1,
    });
  }

  if (isRecord(parsed.error)) {
    const message = typeof parsed.error.message === "string" ? parsed.error.message : "MCP tool call failed.";
    throw new TerminalError({
      code: "RUNTIME_ERROR",
      title: "MCP tool call failed",
      cause: message,
      fix: "Confirm your active MCP key has manage scope and a valid step-up token when required.",
      commandSuggestion: "balchemy auth status",
      exitCode: 1,
    });
  }

  const result = isRecord(parsed.result) ? parsed.result : {};
  const content = Array.isArray(result.content) ? result.content : [];
  const firstText = content
    .map((item) => (isRecord(item) && typeof item.text === "string" ? item.text : null))
    .find((text): text is string => Boolean(text));
  if (!firstText) {
    return result;
  }

  try {
    const decoded = JSON.parse(firstText);
    return isRecord(decoded) ? decoded : { reply: firstText };
  } catch {
    return { reply: firstText };
  }
}

function getNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

function getRuntimeStateFromControlResult(result: Record<string, unknown>): Record<string, unknown> | null {
  const structured = getNestedRecord(result, "structured");
  const stateFromStructured = structured ? getNestedRecord(structured, "state") : null;
  const runtimeFromStructured = structured
    ? getNestedRecord(structured, "autonomous_runtime") ?? getNestedRecord(structured, "autonomousRuntime")
    : null;
  return stateFromStructured
    ?? runtimeFromStructured
    ?? getNestedRecord(result, "state")
    ?? getNestedRecord(result, "autonomous_runtime")
    ?? getNestedRecord(result, "autonomousRuntime");
}

async function controlCommand(commandName: string): Promise<void> {
  const active = loadAgent();
  if (!active) {
    throw new TerminalError({
      code: "UNKNOWN_COMMAND",
      title: "No active agent",
      cause: "Runtime control requires an active saved agent context.",
      fix: "Run balchemy list, then balchemy agent use <publicId>, or run balchemy init.",
      commandSuggestion: "balchemy list",
      exitCode: 2,
    });
  }

  const normalized = normalizeControlAction(commandName, args);
  const toolName = normalized.action === "status" ? "agent_status" : "agent_control";
  const toolArgs: Record<string, unknown> = normalized.action === "status"
    ? {}
    : {
        action: normalized.action,
        ...(normalized.mode ? { mode: normalized.mode } : {}),
        reason: "cli_control",
      };
  const result = await mcpToolCall(active.mcpEndpoint, active.apiKey, toolName, toolArgs);
  const state = getRuntimeStateFromControlResult(result);
  const data: JsonValue = {
    agent: {
      publicId: active.publicId,
      endpointHost: endpointHost(active.mcpEndpoint),
      apiKey: "[redacted]",
    },
    action: normalized.action,
    result: redactJsonValue(result),
    state: state ? redactJsonValue(state) : null,
  };

  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({ ok: true, command: commandName, version: CLI_VERSION, data }));
    return;
  }

  const mode = typeof state?.mode === "string" ? state.mode : "unknown";
  const armed = typeof state?.armed === "boolean" ? String(state.armed) : "unknown";
  const paused = typeof state?.paused === "boolean" ? String(state.paused) : "unknown";
  printSummaryBlock("Autonomous runtime", [
    { label: "Agent", value: active.publicId },
    { label: "Host", value: endpointHost(active.mcpEndpoint) },
    { label: "Action", value: normalized.action },
    { label: "Mode", value: mode },
    { label: "Armed", value: armed },
    { label: "Paused", value: paused },
  ]);
}

function useAgent(publicId: string | undefined): void {
  if (!publicId) {
    throw new TerminalError({
      code: "UNKNOWN_COMMAND",
      title: "Missing agent publicId",
      cause: "balchemy agent use requires a saved agent publicId.",
      fix: "Run balchemy list, then pass the exact publicId to agent use.",
      commandSuggestion: "balchemy list",
      exitCode: 2,
    });
  }

  if (!setActiveAgent(publicId)) {
    throw new TerminalError({
      code: "UNKNOWN_COMMAND",
      title: "Saved agent not found",
      cause: `No saved agent matches ${publicId}.`,
      fix: "Run balchemy list and choose one of the saved publicIds.",
      commandSuggestion: "balchemy list",
      exitCode: 2,
    });
  }

  const active = loadAgent();
  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({
      ok: true,
      command: "agent.use",
      version: CLI_VERSION,
      data: { active: active ? agentToJson(active, active.publicId) : null },
    }));
    return;
  }

  reporter.write(`  ${C.OK}Active agent:${C.R} ${C.W}${publicId}${C.R}\n`);
}

function authLogoutCommand(): void {
  if (parsed.flags.force) {
    clearAgent();
    if (parsed.flags.json) {
      reporter.json(jsonEnvelope({
        ok: true,
        command: "auth.logout",
        version: CLI_VERSION,
        data: { activeCleared: true, credentialsRemoved: false, storePath: getStorePath() },
      }));
      return;
    }
    reporter.write(`  ${C.OK}Active agent cleared.${C.R} ${C.D}Saved encrypted credentials were not removed.${C.R}\n`);
    return;
  }

  throw new TerminalError({
    code: "FILE_OVERWRITE_CONFIRMATION_REQUIRED",
    title: "Logout confirmation required",
    cause: "auth logout clears local active context and must be explicit.",
    fix: "Run balchemy auth status to inspect context, then rerun with --force to clear only the active selection.",
    commandSuggestion: "balchemy auth status",
    docsHint: "Run balchemy auth logout --help for local credential safety notes.",
    exitCode: 4,
  });
}

function printAuthStatus(): void {
  const agents = listAgents();
  const active = loadAgent();
  const data: JsonValue = {
    authenticated: Boolean(active),
    activePublicId: active?.publicId ?? null,
    endpointHost: active ? endpointHost(active.mcpEndpoint) : null,
    savedAgentCount: agents.length,
    encryptedStorePath: getStorePath(),
    credentialsStored: agents.length > 0,
    secrets: {
      apiKeys: agents.length > 0 ? "[redacted]" : null,
      redacted: true,
    },
  };

  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({ ok: true, command: "auth.status", version: CLI_VERSION, data }));
    return;
  }

  printSummaryBlock("Auth status", [
    { label: "Active", value: active ? active.publicId : "none" },
    { label: "Host", value: active ? endpointHost(active.mcpEndpoint) : "none" },
    { label: "Saved", value: String(agents.length) },
    { label: "Store", value: getStorePath() },
    { label: "Secrets", value: agents.length > 0 ? "encrypted locally, redacted" : "none" },
  ]);
}

async function loadConfigWithEnv(configPath: string): Promise<{ config: AgentLoopConfig; resolvedPath: string; envPath: string | null }> {
  const resolvedPath = path.resolve(configPath);
  const dotenv = await import("dotenv");
  const envPath = path.join(path.dirname(resolvedPath), ".env");
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }
  const { loadConfig } = await import("./config-loader.js");
  return {
    config: loadConfig(resolvedPath),
    resolvedPath,
    envPath: fs.existsSync(envPath) ? envPath : null,
  };
}

function configToJson(config: AgentLoopConfig, resolvedPath: string, envPath: string | null): JsonValue {
  return {
    path: resolvedPath,
    envPath,
    mcpEndpoint: config.mcpEndpoint,
    endpointHost: endpointHost(config.mcpEndpoint),
    apiKey: "[redacted]",
    llm: {
      provider: config.llmProvider,
      model: config.llmModel ?? null,
      baseUrl: config.llmBaseUrl ?? null,
      apiKey: "[redacted]",
      maxDailyUsd: config.maxDailyLlmCost ?? null,
      timeoutMs: config.llmTimeoutMs ?? null,
    },
    webhook: {
      port: config.webhookPort ?? null,
      secret: config.webhookSecret ? "[redacted]" : null,
    },
    behaviorRulesConfigured: Boolean(config.behaviorRules || config.behaviorRulesPath),
    redacted: true,
  };
}

async function validateConfigCommand(commandName: string): Promise<void> {
  const configPath = args[0] ?? path.join(process.cwd(), "agent.config.yaml");
  const { config, resolvedPath, envPath } = await loadConfigWithEnv(configPath);
  const data = configToJson(config, resolvedPath, envPath);

  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({ ok: true, command: commandName, version: CLI_VERSION, data }));
    return;
  }

  printSummaryBlock(commandName === "config.list" ? "Effective config" : "Config valid", [
    { label: "Config", value: resolvedPath },
    { label: "Env", value: envPath ?? "not found; process env used" },
    { label: "Endpoint", value: compactValue(config.mcpEndpoint, 42, 12) },
    { label: "Host", value: endpointHost(config.mcpEndpoint) },
    { label: "Provider", value: config.llmProvider },
    { label: "Model", value: config.llmModel ?? "default" },
    { label: "LLM cap", value: `$${(config.maxDailyLlmCost ?? 5).toFixed(2)} / day` },
    { label: "Secrets", value: "resolved and redacted" },
  ]);
}

function initDryRun(): void {
  const yamlPath = path.join(process.cwd(), "agent.config.yaml");
  const envPath = path.join(process.cwd(), ".env");
  const gitignorePath = path.join(process.cwd(), ".gitignore");
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const plan: JsonValue[] = [
    {
      action: fs.existsSync(yamlPath) ? "overwrite" : "create",
      path: yamlPath,
      exists: fs.existsSync(yamlPath),
      wouldOverwrite: fs.existsSync(yamlPath),
      containsSecret: false,
    },
    {
      action: fs.existsSync(envPath) ? "overwrite" : "create",
      path: envPath,
      exists: fs.existsSync(envPath),
      wouldOverwrite: fs.existsSync(envPath),
      containsSecret: true,
    },
    {
      action: gitignore.includes(".env") ? "skip" : (fs.existsSync(gitignorePath) ? "append" : "create"),
      path: gitignorePath,
      exists: fs.existsSync(gitignorePath),
      wouldOverwrite: false,
      containsSecret: false,
    },
  ];

  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({
      ok: true,
      command: "init.preview",
      version: CLI_VERSION,
      data: { dryRun: true, outDir: process.cwd(), plan },
    }));
    return;
  }

  reporter.write(`\n  ${C.T}Setup file preview${C.R} ${C.D}(dry-run; no files written)${C.R}\n`);
  for (const item of plan) {
    const record = item as { action: string; path: string; containsSecret: boolean };
    reporter.write(`  ${record.action.toUpperCase().padEnd(9)} ${record.path}${record.containsSecret ? "  contains secrets" : ""}\n`);
  }
  reporter.write(`\n  ${C.D}Run${C.R} ${C.W}balchemy init${C.R} ${C.D}in an interactive terminal to continue.${C.R}\n\n`);
}

function dockerPlanToJson(plan: { outDir: string; files: Array<{ filename: string; path: string; action: string; exists: boolean; wouldOverwrite: boolean; containsSecret: boolean }>; hasOverwrites: boolean }, dryRun: boolean): JsonValue {
  return {
    outDir: plan.outDir,
    dryRun,
    hasOverwrites: plan.hasOverwrites,
    plan: plan.files.map((file) => ({
      filename: file.filename,
      path: file.path,
      action: file.action,
      exists: file.exists,
      wouldOverwrite: file.wouldOverwrite,
      containsSecret: file.containsSecret,
    })),
  };
}

function renderDockerPlan(plan: { files: Array<{ path: string; action: string; wouldOverwrite: boolean }> }, dryRun: boolean): void {
  reporter.write(`\n  ${C.T}Docker generation ${dryRun ? "preview" : "plan"}${C.R}${dryRun ? ` ${C.D}(dry-run; no files written)${C.R}` : ""}\n`);
  for (const file of plan.files) {
    const label = file.action.toUpperCase().padEnd(9);
    const suffix = file.wouldOverwrite ? `  ${C.W}requires confirmation${C.R}` : "";
    reporter.write(`  ${label} ${file.path}${suffix}\n`);
  }
}

async function dockerCommand(): Promise<void> {
  const outDir = path.resolve(args[0] ?? process.cwd());
  const { buildDockerPlan, generateDocker } = await import("./docker-gen.js");
  const plan = buildDockerPlan(outDir);

  if (parsed.flags.json) {
    if (!parsed.flags.dryRun && plan.hasOverwrites && !parsed.flags.force) {
      throw new TerminalError({
        code: "FILE_OVERWRITE_CONFIRMATION_REQUIRED",
        title: "Overwrite confirmation required",
        cause: "Docker generation would overwrite existing files.",
        fix: "Run with --dry-run to inspect or pass --force after reviewing the target paths.",
        commandSuggestion: `balchemy docker ${outDir} --dry-run --json`,
        exitCode: 4,
      });
    }
    const written = parsed.flags.dryRun ? plan : await generateDocker(outDir, { force: parsed.flags.force });
    reporter.json(jsonEnvelope({
      ok: true,
      command: parsed.flags.dryRun ? "docker.generate.preview" : "docker.generate",
      version: CLI_VERSION,
      data: dockerPlanToJson(written, parsed.flags.dryRun),
    }));
    return;
  }

  renderDockerPlan(plan, parsed.flags.dryRun);
  if (parsed.flags.dryRun) {
    reporter.write(`\n  ${C.D}Run without --dry-run to write files. Use --force only after reviewing overwrites.${C.R}\n\n`);
    return;
  }

  if (plan.hasOverwrites && !parsed.flags.force) {
    if (parsed.flags.ci || isNonInteractive(parsed.flags)) {
      throw new TerminalError({
        code: "FILE_OVERWRITE_CONFIRMATION_REQUIRED",
        title: "Overwrite confirmation required",
        cause: "Docker generation would overwrite files, and this session cannot prompt.",
        fix: "Run balchemy docker --dry-run to inspect, then rerun with --force if the overwrites are intended.",
        commandSuggestion: `balchemy docker ${outDir} --dry-run`,
        exitCode: 4,
      });
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY && process.stdout.isTTY });
    const answer = await ask(rl, `${C.W}Type overwrite to replace existing Docker files${C.R}`);
    rl.close();
    if (answer !== "overwrite") {
      throw new TerminalError({
        code: "FILE_OVERWRITE_CONFIRMATION_REQUIRED",
        title: "Docker generation cancelled",
        cause: "Overwrite confirmation was not provided.",
        fix: "No files were changed. Rerun with --dry-run to inspect the plan.",
        commandSuggestion: `balchemy docker ${outDir} --dry-run`,
        exitCode: 4,
      });
    }
  }

  await generateDocker(outDir, { force: parsed.flags.force || plan.hasOverwrites });
  reporter.write(`\n  ${C.OK}Docker files written to${C.R} ${outDir}\n`);
  reporter.write(`\n  ${C.W}Next steps${C.R}\n`);
  reporter.write(`  1. Copy .env.example to .env and fill in your credentials\n`);
  reporter.write(`  2. Place agent.config.yaml in the same directory\n`);
  reporter.write(`  3. Run: docker compose up -d\n\n`);
}

async function doctorCommand(): Promise<void> {
  const configPath = args[0] ?? path.join(process.cwd(), "agent.config.yaml");
  const checks: Array<{ name: string; status: "ok" | "warn" | "error"; detail: string }> = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node-version",
    status: nodeMajor >= 18 ? "ok" : "error",
    detail: `Node ${process.versions.node}; required >=18`,
  });
  checks.push({
    name: "agent-store",
    status: fs.existsSync(getStorePath()) ? "ok" : "warn",
    detail: fs.existsSync(getStorePath()) ? `Encrypted store found at ${getStorePath()}` : `No encrypted store at ${getStorePath()}`,
  });
  checks.push({
    name: "terminal",
    status: process.stdout.isTTY ? "ok" : "warn",
    detail: process.stdout.isTTY ? "stdout is interactive" : "stdout is non-interactive; TUI commands will be blocked",
  });
  checks.push({
    name: "config-file",
    status: fs.existsSync(configPath) ? "ok" : "warn",
    detail: fs.existsSync(configPath) ? `Config found at ${path.resolve(configPath)}` : `Config not found at ${path.resolve(configPath)}`,
  });

  if (fs.existsSync(configPath)) {
    try {
      const loaded = await loadConfigWithEnv(configPath);
      checks.push({
        name: "config-validate",
        status: "ok",
        detail: `Config resolves for ${endpointHost(loaded.config.mcpEndpoint)}`,
      });
    } catch (err: unknown) {
      checks.push({
        name: "config-validate",
        status: "error",
        detail: toTerminalError(err).cause,
      });
    }
  }

  const hasErrors = checks.some((check) => check.status === "error");
  if (parsed.flags.json) {
    reporter.json(jsonEnvelope({
      ok: !hasErrors,
      command: "doctor",
      version: CLI_VERSION,
      data: { checks: checks as unknown as JsonValue, configPath: path.resolve(configPath) },
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

async function startFromConfig(): Promise<void> {
  ensureInteractive("balchemy start");
  const configPath = args[0] ?? path.join(process.cwd(), "agent.config.yaml");
  const { config } = await loadConfigWithEnv(configPath);
  const publicId = config.mcpEndpoint.split("/").filter(Boolean).pop() ?? "unknown";
  const { startTui } = await import("./tui/start.js");
  await startTui({
    mcpEndpoint: config.mcpEndpoint,
    apiKey: config.apiKey,
    llmProvider: config.llmProvider,
    llmApiKey: config.llmApiKey,
    llmModel: config.llmModel,
    llmBaseUrl: config.llmBaseUrl,
    maxDailyLlmCost: config.maxDailyLlmCost,
    llmTimeoutMs: config.llmTimeoutMs,
    publicId,
    strategy: "custom",
    shadowMode: config.shadowMode === false ? false : true,
    behaviorRules: config.behaviorRules,
    autoSeedSubscriptions: false,
  });
}

async function defaultLauncher(): Promise<void> {
  if (parsed.flags.json) {
    printAgentCurrent();
    return;
  }
  ensureInteractive("balchemy");

  const agents = listAgents();
  const active = loadAgent();
  const last = active ?? mostRecentAgent(agents);

  if (!last) {
    await runWizardFromCwd();
    return;
  }

  const { renderLogo } = await import("./terminal-logo.js");
  reporter.write(renderLogo(20));
  reporter.write(`\n  ${C.G}B${C.T}alchemy ${C.W}Agent${C.R}\n`);
  reporter.write(`  ${C.D}Saved agents ready${C.R}\n\n`);
  printSummaryBlock(active ? "Last session" : "Most recent session", [
    { label: "Agent", value: last.publicId },
    { label: "Endpoint", value: compactValue(last.mcpEndpoint, 42, 12) },
    { label: "Host", value: endpointHost(last.mcpEndpoint) },
    { label: "Model", value: last.llmModel ?? "default" },
    { label: "Strategy", value: compactValue(last.strategy, 42, 8) },
    { label: "Mode", value: last.shadowMode ? "Shadow" : "Live-approved" },
    { label: "Saved", value: last.createdAt },
  ]);
  const actions = [
    { label: "y", value: "Resume this agent" },
    ...(agents.length > 1 ? [{ label: "list", value: "Choose another saved agent" }] : []),
    { label: "new", value: "Create a new agent or connect existing credentials" },
  ];
  printSummaryBlock("Available actions", actions);
  reporter.write("\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY && process.stdout.isTTY });
  try {
    const choice = normalizeChoice(await ask(
      rl,
      `${C.W}Action?${C.R} (y${agents.length > 1 ? "/list" : ""}/new)`,
      "y",
    ));

    if (choice === "y" || choice === "yes" || choice === "resume" || choice === "last") {
      await startSavedAgent(last);
    } else if (
      Number.isInteger(Number(choice))
      && Number(choice) >= 1
      && Number(choice) <= agents.length
    ) {
      await startSavedAgent(agents[Number(choice) - 1]!);
    } else if (
      agents.length > 1
      && (choice === "list" || choice === "choose" || choice === "select" || choice === "agents")
    ) {
      const selected = await chooseSavedAgent(rl, agents);
      if (!selected) {
        reporter.warn(`  ${C.D}No matching saved agent. Starting setup instead.${C.R}\n\n`);
        await runWizardFromCwd();
      } else {
        await startSavedAgent(selected);
      }
    } else if (choice === "new" || choice === "n") {
      await runWizardFromCwd();
    } else {
      reporter.warn(`  ${C.D}Unknown action. Starting setup instead.${C.R}\n\n`);
      await runWizardFromCwd();
    }
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  if (parsed.unknownFlags.length > 0) {
    throw new TerminalError({
      code: "UNKNOWN_FLAG",
      title: "Unknown flag",
      cause: `Unsupported flag${parsed.unknownFlags.length > 1 ? "s" : ""}: ${parsed.unknownFlags.join(", ")}`,
      fix: "Remove the unsupported flag or run help to see supported global flags.",
      commandSuggestion: "balchemy --help",
      exitCode: 2,
    });
  }

  if (parsed.flags.help || cmd === "help") {
    printHelp();
    return;
  }
  if (parsed.flags.version || cmd === "version") {
    printVersion();
    return;
  }

  await checkForUpdate(parsed.flags);

  switch (cmd) {
    case "init":
      if (parsed.flags.dryRun) {
        initDryRun();
        return;
      }
      await runWizardFromCwd();
      return;
    case "start":
      await startFromConfig();
      return;
    case "docker":
      await dockerCommand();
      return;
    case "list":
    case "agent list":
      printAgentList(cmd === "list" ? "agent.list" : "agent.list");
      return;
    case "agent current":
      printAgentCurrent();
      return;
    case "control":
    case "control status":
    case "control pause":
    case "control resume":
    case "control arm":
    case "control disarm":
    case "control set-mode":
    case "control set_mode":
    case "agent control":
      await controlCommand(cmd);
      return;
    case "auth login":
      if (parsed.flags.dryRun) {
        initDryRun();
        return;
      }
      await runWizardFromCwd();
      return;
    case "agent use":
      useAgent(args[0]);
      return;
    case "auth status":
      printAuthStatus();
      return;
    case "auth logout":
      authLogoutCommand();
      return;
    case "config validate":
      await validateConfigCommand("config.validate");
      return;
    case "config list":
      await validateConfigCommand("config.list");
      return;
    case "doctor":
      await doctorCommand();
      return;
    case "":
      await defaultLauncher();
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
