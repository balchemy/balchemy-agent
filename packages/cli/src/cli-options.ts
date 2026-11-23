export interface CliFlags {
  help: boolean;
  version: boolean;
  noColor: boolean;
  json: boolean;
  quiet: boolean;
  verbose: boolean;
  debug: boolean;
  ci: boolean;
  dryRun: boolean;
  yes: boolean;
  force: boolean;
}

export interface ParsedCliArgs {
  flags: CliFlags;
  commandPath: string[];
  args: string[];
  unknownFlags: string[];
}

const GLOBAL_FLAG_ALIASES: Record<string, keyof CliFlags> = {
  "--help": "help",
  "-h": "help",
  "--version": "version",
  "-v": "version",
  "--no-color": "noColor",
  "--json": "json",
  "--quiet": "quiet",
  "-q": "quiet",
  "--verbose": "verbose",
  "--debug": "debug",
  "--ci": "ci",
  "--dry-run": "dryRun",
  "--yes": "yes",
  "-y": "yes",
  "--force": "force",
};

function defaultFlags(): CliFlags {
  return {
    help: false,
    version: false,
    noColor: false,
    json: false,
    quiet: false,
    verbose: false,
    debug: false,
    ci: false,
    dryRun: false,
    yes: false,
    force: false,
  };
}

function splitCommandAndArgs(positional: string[]): { commandPath: string[]; args: string[] } {
  const first = positional[0];
  const second = positional[1];

  if (!first) return { commandPath: [], args: [] };

  if (first === "runner" && ["start", "add", "status", "stop", "arm", "disarm", "shutdown", "recover", "pair", "model", "chat", "result", "model-lock", "model-save", "model-unlock", "model-status", "rules", "intent", "decisions", "decision", "limits", "budget", "sizing", "wallet", "rpc", "trades", "positions", "owner-pin"].includes(second ?? "")) {
    return { commandPath: [first, second as string], args: positional.slice(2) };
  }

  return { commandPath: [first], args: positional.slice(1) };
}

export function parseCliArgs(rawArgs: string[]): ParsedCliArgs {
  const flags = defaultFlags();
  const positional: string[] = [];
  const unknownFlags: string[] = [];

  for (const arg of rawArgs) {
    if (arg === "--init") {
      positional.push("init");
      continue;
    }

    const flagName = GLOBAL_FLAG_ALIASES[arg];
    if (flagName) {
      flags[flagName] = true;
      continue;
    }

    if (arg === "--before" && positional[0] === "runner" && positional[1] === "decisions") {
      positional.push(arg);
      continue;
    }

    if (arg === "--runner" && positional[0] === "doctor" && positional.length === 1) {
      positional.push(arg);
      continue;
    }

    if (arg === "--daily-calls" && positional[0] === "runner" && positional[1] === "limits") {
      positional.push(arg);
      continue;
    }

    if (arg === "--daily-usd" && positional[0] === "runner" && positional[1] === "budget") {
      positional.push(arg);
      continue;
    }

    if (arg === "--launchpads" && positional[0] === "runner" && positional[1] === "signals") {
      positional.push(arg);
      continue;
    }

    if (["--amount-sol", "--slippage-bps"].includes(arg) && positional[0] === "runner" && positional[1] === "sizing") {
      positional.push(arg);
      continue;
    }

    if (["--per-trade", "--daily"].includes(arg) && positional[0] === "runner" && positional[1] === "wallet") {
      positional.push(arg);
      continue;
    }

    if (arg.startsWith("--")) {
      unknownFlags.push(arg);
      continue;
    }

    positional.push(arg);
  }

  const { commandPath, args } = splitCommandAndArgs(positional);
  return { flags, commandPath, args, unknownFlags };
}

export function commandKey(commandPath: string[]): string {
  return commandPath.join(" ");
}
