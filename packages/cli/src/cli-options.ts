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

  if (first === "agent" && ["list", "current", "use", "control"].includes(second ?? "")) {
    return { commandPath: [first, second as string], args: positional.slice(2) };
  }

  if (first === "control") {
    const controlActions = ["status", "pause", "resume", "arm", "disarm", "set-mode", "set_mode"];
    if (controlActions.includes(second ?? "")) {
      return { commandPath: [first, second as string], args: positional.slice(2) };
    }
    return { commandPath: [first], args: positional.slice(1) };
  }

  if (first === "auth" && ["status", "login", "logout"].includes(second ?? "")) {
    return { commandPath: [first, second as string], args: positional.slice(2) };
  }

  if (first === "context" && ["current", "status"].includes(second ?? "")) {
    return { commandPath: ["agent", "current"], args: positional.slice(2) };
  }

  if (first === "tui") {
    return { commandPath: ["start"], args: positional.slice(1) };
  }

  if (first === "config" && ["validate", "list"].includes(second ?? "")) {
    return { commandPath: [first, second as string], args: positional.slice(2) };
  }

  if (first === "docker" && second === "generate") {
    return { commandPath: [first], args: positional.slice(2) };
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

export function isNonInteractive(flags: CliFlags): boolean {
  return flags.ci || !process.stdin.isTTY || !process.stdout.isTTY;
}
