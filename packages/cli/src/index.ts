#!/usr/bin/env node
/**
 * balchemy CLI entry point.
 *
 * On launch:
 *   - If ~/.balchemy/agents.enc has saved agents → offer resume, choose, or create/connect
 *   - If no saved agent → run wizard
 *
 * Sub-commands:
 *   (no args)       Resume cached agent or run wizard
 *   init / --init   Force run wizard (ignore cache)
 *   start [config]  Start from agent.config.yaml
 *   docker [outDir] Generate Docker files
 */

import * as path from "path";
import * as readline from "readline";
import {
  loadAgent,
  listAgents,
  setActiveAgent,
  type StoredAgent,
} from "./agent-store.js";

const [, , cmd, ...args] = process.argv;

const T = "\x1b[38;2;0;172;176m";
const G = "\x1b[38;2;186;115;6m";
const W = "\x1b[1;37m";
const D = "\x1b[38;5;245m";
const R = "\x1b[0m";

function printSummaryBlock(title: string, rows: Array<{ label: string; value: string }>): void {
  const maxLabel = rows.reduce((acc, row) => Math.max(acc, row.label.length), 0);
  process.stdout.write(`  ${T}${title}${R}\n`);
  for (const row of rows) {
    process.stdout.write(`  ${D}${row.label.padEnd(maxLabel)}${R}  ${row.value}\n`);
  }
  process.stdout.write(`  ${D}${"-".repeat(54)}${R}\n`);
}

function ask(rl: readline.Interface, question: string, defaultVal = ""): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` ${D}[${defaultVal}]${R}` : "";
    rl.question(`  ${T}${question}${R}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

function compactValue(value: string, head = 28, tail = 8): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

function normalizeChoice(value: string): string {
  return value.trim().toLowerCase();
}

function mostRecentAgent(agents: StoredAgent[]): StoredAgent | null {
  if (agents.length === 0) return null;
  return [...agents].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  })[0] ?? null;
}

async function startSavedAgent(agent: StoredAgent): Promise<void> {
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
  const { runWizard } = await import("./wizard.js");
  await runWizard(process.cwd());
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
  const answer = normalizeChoice(await ask(rl, `${W}Choose agent number or publicId${R}`, "1"));
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

async function checkForUpdate(): Promise<boolean> {
  try {
    const res = await fetch("https://registry.npmjs.org/balchemy/latest", {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { version?: string };
    const latest = data.version;
    if (!latest) return false;

    const { createRequire } = await import("module");
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version: string };
    const current = pkg.version;

    if (isNewerVersion(latest, current)) {
      process.stdout.write(
        `\n  ${G}Update available${R} ${D}${current}${R} → ${T}${latest}${R}\n`,
      );

      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await ask(rl, `${W}Update now?${R} (Y/n)`, "y");
      rl.close();

      if (answer.toLowerCase() === "y" || answer.toLowerCase() === "yes") {
        // Detect if running via npx (no global binary to re-exec)
        const isNpx = Boolean(
          process.env.npm_execpath?.includes("npx") ||
          process.env._?.includes("npx") ||
          process.env.npm_command === "exec",
        );

        process.stdout.write(`  Updating to ${T}${latest}${R}...\n`);
        const { execSync } = await import("child_process");
        try {
          execSync(`npm install -g balchemy@${latest}`, { stdio: "inherit" });
          if (isNpx) {
            process.stdout.write(`\n  ${T}Updated!${R} Run ${W}balchemy${R} to use the new version.\n\n`);
            // Continue with current version — don't re-exec, npx cache may be stale
          } else {
            process.stdout.write(`\n  ${T}Updated!${R} Restarting...\n\n`);
            const { execFileSync } = await import("child_process");
            execFileSync("balchemy", process.argv.slice(2), { stdio: "inherit" });
            process.exit(0);
          }
        } catch {
          process.stdout.write(`  ${D}Update failed. Continuing with ${current}.${R}\n\n`);
        }
      } else {
        process.stdout.write(`  ${D}Skipped.${R}\n\n`);
      }
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  // Check for updates — if updated, the process re-execs and exits
  await checkForUpdate();

  switch (cmd) {
    case "--init":
    case "init": {
      // Force wizard — ignore cache
      await runWizardFromCwd();
      break;
    }

    case "start": {
      const configPath = args[0] ?? path.join(process.cwd(), "agent.config.yaml");
      const resolvedPath = path.resolve(configPath);
      const dotenv = await import("dotenv");
      const envPath = path.join(path.dirname(resolvedPath), ".env");
      const fs = await import("fs");
      if (fs.existsSync(envPath)) {
        dotenv.config({ path: envPath });
      } else {
        dotenv.config();
      }
      const { loadConfig } = await import("./config-loader.js");
      const config = loadConfig(resolvedPath);
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
        shadowMode: false,
        behaviorRules: config.behaviorRules,
        autoSeedSubscriptions: false,
      });
      break;
    }

    case "docker": {
      const outDir = args[0] ?? process.cwd();
      const { generateDocker } = await import("./docker-gen.js");
      await generateDocker(outDir);
      process.stdout.write(`Docker files written to ${outDir}\n`);
      break;
    }

    case undefined: {
      // Default: choose from saved agents or run wizard.
      const agents = listAgents();
      const active = loadAgent();
      const last = active ?? mostRecentAgent(agents);

      if (last) {
        // Show last/active agent info and ask what to do.
        const { renderLogo } = await import("./terminal-logo.js");
        process.stdout.write(renderLogo(20));
        process.stdout.write(`\n  ${G}B${T}alchemy ${W}Agent${R}\n`);
        process.stdout.write(`  ${D}Saved agents ready${R}\n\n`);
        printSummaryBlock(active ? "Last session" : "Most recent session", [
          { label: "Agent", value: last.publicId },
          { label: "Endpoint", value: compactValue(last.mcpEndpoint, 42, 12) },
          { label: "Model", value: last.llmModel ?? "default" },
          { label: "Strategy", value: compactValue(last.strategy, 42, 8) },
          { label: "Mode", value: last.shadowMode ? "Shadow" : "LIVE" },
          { label: "Saved", value: last.createdAt },
        ]);
        const actions = [
          { label: "y", value: "Resume this agent" },
          ...(agents.length > 1 ? [{ label: "list", value: "Choose another saved agent" }] : []),
          { label: "new", value: "Create a new agent or connect existing credentials" },
        ];
        printSummaryBlock("Available actions", actions);
        process.stdout.write("\n");

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        try {
          const choice = normalizeChoice(await ask(
            rl,
            `${W}Action?${R} (y${agents.length > 1 ? "/list" : ""}/new)`,
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
              process.stdout.write(`  ${D}No matching saved agent. Starting setup instead.${R}\n\n`);
              await runWizardFromCwd();
            } else {
              await startSavedAgent(selected);
            }
          } else if (choice === "new" || choice === "n") {
            await runWizardFromCwd();
          } else {
            process.stdout.write(`  ${D}Unknown action. Starting setup instead.${R}\n\n`);
            await runWizardFromCwd();
          }
        } finally {
          rl.close();
        }
      } else {
        // No saved agent — run wizard.
        await runWizardFromCwd();
      }
      break;
    }

    default: {
      process.stdout.write(`${T}Balchemy Agent CLI${R}\n\n`);
      printSummaryBlock("Commands", [
        { label: "balchemy", value: "Resume/select an agent or run setup" },
        { label: "balchemy init", value: "Force a fresh setup wizard" },
        { label: "balchemy start [config]", value: "Start from an existing config file" },
        { label: "balchemy docker [outDir]", value: "Generate Docker files for deployment" },
      ]);
      process.stdout.write("\n");
      break;
    }
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
