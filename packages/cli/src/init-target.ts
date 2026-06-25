import * as fs from "node:fs";
import * as path from "node:path";
import { TerminalError } from "./errors.js";

const BALCHEMY_SOURCE_CHECKOUT_MARKERS = [
  "AGENTS.md",
  "balchemy-backend",
  "balchemy-frontend-v2",
  "create-balchemy-agent",
] as const;

export function isBalchemySourceCheckout(dir: string): boolean {
  const resolvedDir = path.resolve(dir);

  return BALCHEMY_SOURCE_CHECKOUT_MARKERS.every((marker) =>
    fs.existsSync(path.join(resolvedDir, marker))
  );
}

export function assertSafeInitDirectory(dir: string): void {
  const resolvedDir = path.resolve(dir);
  if (!isBalchemySourceCheckout(resolvedDir)) return;

  throw new TerminalError({
    code: "UNSAFE_INIT_DIRECTORY",
    title: "Unsafe init directory",
    cause: `balchemy init is running inside the Balchemy source checkout: ${resolvedDir}`,
    fix: [
      "Run setup from a separate agent directory.",
      "The public CLI writes local agent config files only;",
      "it should not overwrite Balchemy repository files.",
    ].join(" "),
    commandSuggestion: [
      "mkdir -p ~/balchemy-agents/my-agent",
      "cd ~/balchemy-agents/my-agent",
      "npx balchemy init",
    ].join(" && "),
    exitCode: 2,
  });
}
