/**
 * Generates Dockerfile + docker-compose.yml for the agent.
 * Copies static template files and does not mutate them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { TerminalError } from "./errors.js";

const __filename_esm = fileURLToPath(import.meta.url);
const __dirname_esm = path.dirname(__filename_esm);
const TEMPLATES_DIR = path.join(__dirname_esm, "..", "templates");

export type DockerFileAction = "create" | "overwrite" | "skip";

export interface DockerFilePlan {
  filename: string;
  path: string;
  action: DockerFileAction;
  exists: boolean;
  wouldOverwrite: boolean;
  containsSecret: boolean;
}

export interface DockerGenerationPlan {
  outDir: string;
  files: DockerFilePlan[];
  hasOverwrites: boolean;
}

export interface DockerGenerationOptions {
  dryRun?: boolean;
  force?: boolean;
}

function templatePath(filename: string): string {
  return path.join(TEMPLATES_DIR, filename);
}

function assertTemplateExists(filename: string): void {
  const src = templatePath(filename);
  if (!fs.existsSync(src)) {
    throw new TerminalError({
      code: "CONFIG_FILE_MISSING",
      title: "Docker template missing",
      cause: `Template file not found: ${src}`,
      fix: "Reinstall the balchemy CLI package or run from a complete build artifact.",
      exitCode: 2,
    });
  }
}

function plannedFile(outDir: string, filename: string, overwriteAllowed: boolean): DockerFilePlan {
  const dest = path.join(outDir, filename);
  const exists = fs.existsSync(dest);
  return {
    filename,
    path: dest,
    action: exists ? (overwriteAllowed ? "overwrite" : "skip") : "create",
    exists,
    wouldOverwrite: exists && overwriteAllowed,
    containsSecret: false,
  };
}

export function buildDockerPlan(outDir: string): DockerGenerationPlan {
  if (!fs.existsSync(outDir)) {
    throw new TerminalError({
      code: "CONFIG_FILE_MISSING",
      title: "Output directory does not exist",
      cause: `Output directory does not exist: ${outDir}`,
      fix: "Create the directory first or pass an existing output directory.",
      commandSuggestion: "mkdir -p ./deploy && balchemy docker ./deploy --dry-run",
      exitCode: 2,
    });
  }

  if (!fs.statSync(outDir).isDirectory()) {
    throw new TerminalError({
      code: "CONFIG_FILE_MISSING",
      title: "Output path is not a directory",
      cause: `Output path is not a directory: ${outDir}`,
      fix: "Pass a directory path for Docker file generation.",
      exitCode: 2,
    });
  }

  for (const filename of ["Dockerfile", "docker-compose.yml", ".env.example"]) {
    assertTemplateExists(filename);
  }

  const files = [
    plannedFile(outDir, "Dockerfile", true),
    plannedFile(outDir, "docker-compose.yml", true),
    plannedFile(outDir, ".env.example", false),
  ];

  return {
    outDir,
    files,
    hasOverwrites: files.some((file) => file.wouldOverwrite),
  };
}

function copyTemplate(filename: string, dest: string): void {
  fs.copyFileSync(templatePath(filename), dest);
}

export async function generateDocker(
  outDir: string,
  options: DockerGenerationOptions = {},
): Promise<DockerGenerationPlan> {
  const plan = buildDockerPlan(outDir);

  if (options.dryRun) {
    return plan;
  }

  if (plan.hasOverwrites && !options.force) {
    const targets = plan.files
      .filter((file) => file.wouldOverwrite)
      .map((file) => file.path)
      .join(", ");
    throw new TerminalError({
      code: "FILE_OVERWRITE_CONFIRMATION_REQUIRED",
      title: "Overwrite confirmation required",
      cause: `Existing files would be overwritten: ${targets}`,
      fix: "Review the preview and type overwrite, or rerun with --dry-run to inspect without writing.",
      commandSuggestion: `balchemy docker ${outDir} --dry-run`,
      exitCode: 4,
    });
  }

  for (const file of plan.files) {
    if (file.action === "skip") continue;
    copyTemplate(file.filename, file.path);
  }

  return plan;
}
