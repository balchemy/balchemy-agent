/**
 * Starts the AgentLoop from a config file path.
 * Handles process signals (SIGINT, SIGTERM) for graceful shutdown.
 */

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
import { AgentLoop } from '@balchemyai/agent-sdk';
import { loadConfig } from './config-loader.js';

function loadDotEnv(configPath: string): void {
  // Look for .env relative to the config file directory
  const envPath = path.join(path.dirname(configPath), '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    // Fall back to cwd
    dotenv.config();
  }
}

export async function runAgent(configPath: string): Promise<void> {
  const resolvedPath = path.resolve(configPath);

  // Load .env before parsing config (config may reference env vars)
  loadDotEnv(resolvedPath);

  process.stdout.write(`Starting Balchemy agent from: ${resolvedPath}\n`);

  const config = loadConfig(resolvedPath);

  const loop = new AgentLoop({
    ...config,
    onStatusChange: (status) => {
      process.stdout.write(
        `[agent] status=${status.status} events=${status.eventsReceived} ` +
        `decisions=${status.decisionsExecuted} trades=${status.tradesExecuted} ` +
        `llmCost=$${status.llmCostToday.toFixed(4)}/${status.maxDailyLlmCost}\n`,
      );
    },
    onDecision: (decision) => {
      process.stdout.write(
        `[agent] decision action=${decision.action}` +
        (decision.token ? ` token=${decision.token}` : '') +
        (decision.amount ? ` amount=${decision.amount}` : '') +
        (decision.confidence !== undefined ? ` confidence=${decision.confidence}` : '') +
        '\n',
      );
    },
    onError: (err) => {
      process.stderr.write(`[agent] error: ${err.message}\n`);
    },
  });

  // Graceful shutdown
  let stopping = false;
  const shutdown = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n[agent] Shutting down...\n');
    await loop.stop();
    process.stdout.write('[agent] Stopped.\n');
    process.exit(0);
  };

  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });

  await loop.start();
  process.stdout.write('[agent] Running. Press Ctrl+C to stop.\n');

  // Keep process alive
  await new Promise<void>(() => { /* intentionally never resolves */ });
}
