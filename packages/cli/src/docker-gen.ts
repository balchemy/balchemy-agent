/**
 * Generates Dockerfile + docker-compose.yml for the agent.
 * Copies static template files and does not mutate them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);
const TEMPLATES_DIR = path.join(__dirname_esm, '..', 'templates');

function copyTemplate(filename: string, outDir: string): void {
  const src = path.join(TEMPLATES_DIR, filename);
  const dest = path.join(outDir, filename);
  if (!fs.existsSync(src)) {
    throw new Error(`Template file not found: ${src}`);
  }
  fs.copyFileSync(src, dest);
  process.stdout.write(`  wrote ${dest}\n`);
}

export async function generateDocker(outDir: string): Promise<void> {
  if (!fs.existsSync(outDir)) {
    throw new Error(`Output directory does not exist: ${outDir}`);
  }

  process.stdout.write(`Generating Docker files in ${outDir}...\n`);

  copyTemplate('Dockerfile', outDir);
  copyTemplate('docker-compose.yml', outDir);

  // Write .env.example only if not already present (don't overwrite real .env)
  const envExampleDest = path.join(outDir, '.env.example');
  if (!fs.existsSync(envExampleDest)) {
    copyTemplate('.env.example', envExampleDest);
  } else {
    process.stdout.write(`  skipped .env.example (already exists)\n`);
  }

  process.stdout.write(
    `\nNext steps:\n` +
    `  1. Copy .env.example to .env and fill in your credentials\n` +
    `  2. Place your agent.config.yaml in the same directory\n` +
    `  3. Run: docker compose up -d\n`,
  );
}
