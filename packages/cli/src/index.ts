#!/usr/bin/env node
/**
 * balchemy CLI entry point.
 *
 * On launch:
 *   - If ~/.balchemy/agent.json exists → offer to resume or start fresh
 *   - If no cached agent → run wizard
 *
 * Sub-commands:
 *   (no args)       Resume cached agent or run wizard
 *   init / --init   Force run wizard (ignore cache)
 *   start [config]  Start from agent.config.yaml
 *   docker [outDir] Generate Docker files
 */

import * as path from "path";
import * as readline from "readline";
import { loadAgent, clearAgent, getStorePath } from "./agent-store.js";

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

    if (latest !== current) {
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
      const { runWizard } = await import("./wizard.js");
      await runWizard(process.cwd());
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
      // Default: check for cached agent
      const cached = loadAgent();

      if (cached) {
        // Show cached agent info and ask what to do
        const { renderLogo } = await import("./terminal-logo.js");
        process.stdout.write(renderLogo(20));
        process.stdout.write(`\n  ${G}B${T}alchemy ${W}Agent${R}\n`);
        process.stdout.write(`  ${D}Saved session ready to resume${R}\n\n`);
        printSummaryBlock("Saved session", [
          { label: "Agent", value: cached.publicId },
          { label: "Endpoint", value: cached.mcpEndpoint },
          { label: "Model", value: cached.llmModel ?? "default" },
          { label: "Strategy", value: cached.strategy },
          { label: "Mode", value: cached.shadowMode ? "Shadow" : "LIVE" },
          { label: "Saved", value: cached.createdAt },
        ]);
        printSummaryBlock("Available actions", [
          { label: "y", value: "Resume this saved session" },
          { label: "n", value: "Keep the cache and open setup again" },
          { label: "new", value: "Clear saved state and start fresh" },
        ]);
        process.stdout.write("\n");

        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        const choice = await ask(rl, `${W}Resume this agent?${R} (y/n/new)`, "y");
        rl.close();

        if (choice === "y" || choice === "yes") {
          // Resume — go straight to TUI
          const { startTui } = await import("./tui/start.js");
          await startTui({
            mcpEndpoint: cached.mcpEndpoint,
            apiKey: cached.apiKey,
            llmProvider: cached.llmProvider,
            llmApiKey: cached.llmApiKey,
            llmModel: cached.llmModel,
            llmBaseUrl: cached.llmBaseUrl,
            maxDailyLlmCost: cached.maxDailyLlmCost,
            llmTimeoutMs: cached.llmTimeoutMs,
            publicId: cached.publicId,
            strategy: cached.strategy,
            shadowMode: cached.shadowMode,
            behaviorRules: cached.behaviorRules,
            autoSeedSubscriptions: false,
          });
        } else if (choice === "new" || choice === "n") {
          // New agent — clear cache and run wizard
          if (choice === "new") clearAgent();
          const { runWizard } = await import("./wizard.js");
          await runWizard(process.cwd());
        }
      } else {
        // No cached agent — run wizard
        const { runWizard } = await import("./wizard.js");
        await runWizard(process.cwd());
      }
      break;
    }

    default: {
      process.stdout.write(`${T}Balchemy Agent CLI${R}\n\n`);
      printSummaryBlock("Commands", [
        { label: "balchemy", value: "Resume agent or run setup" },
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
