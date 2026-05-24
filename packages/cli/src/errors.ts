import { C } from "./colors.js";
import type { JsonValue, Reporter } from "./output.js";

export type TerminalErrorCode =
  | "UNKNOWN_COMMAND"
  | "UNKNOWN_FLAG"
  | "CONFIG_FILE_MISSING"
  | "CONFIG_ENV_MISSING"
  | "CONFIG_YAML_INVALID"
  | "FILE_OVERWRITE_CONFIRMATION_REQUIRED"
  | "FILE_PERMISSION_DENIED"
  | "CI_PROMPT_BLOCKED"
  | "TERMINAL_UNSUPPORTED_TUI"
  | "RUNTIME_ERROR";

export interface TerminalErrorParams {
  code: TerminalErrorCode;
  title: string;
  cause: string;
  fix: string;
  commandSuggestion?: string;
  docsHint?: string;
  exitCode: number;
  retryable?: boolean;
  debugDetails?: string;
}

export class TerminalError extends Error {
  readonly code: TerminalErrorCode;
  readonly title: string;
  readonly cause: string;
  readonly fix: string;
  readonly commandSuggestion?: string;
  readonly docsHint: string;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly debugDetails?: string;

  constructor(params: TerminalErrorParams) {
    super(params.title);
    this.name = "TerminalError";
    this.code = params.code;
    this.title = params.title;
    this.cause = params.cause;
    this.fix = params.fix;
    this.commandSuggestion = params.commandSuggestion;
    this.docsHint = params.docsHint ?? "Run balchemy --help for command usage.";
    this.exitCode = params.exitCode;
    this.retryable = params.retryable ?? false;
    this.debugDetails = params.debugDetails;
  }
}

export function toTerminalError(err: unknown): TerminalError {
  if (err instanceof TerminalError) return err;

  const message = err instanceof Error ? err.message : String(err);
  if (/Config file not found:/i.test(message)) {
    return new TerminalError({
      code: "CONFIG_FILE_MISSING",
      title: "Missing config file",
      cause: message,
      fix: "Run balchemy init or pass a config path.",
      commandSuggestion: "balchemy start ./agent.config.yaml",
      exitCode: 2,
      debugDetails: err instanceof Error ? err.stack : undefined,
    });
  }
  if (/Environment variable '.+' referenced in config is not set/i.test(message)) {
    return new TerminalError({
      code: "CONFIG_ENV_MISSING",
      title: "Missing environment variable",
      cause: message,
      fix: "Add the missing variable to .env next to the config file or export it before running balchemy start.",
      commandSuggestion: "balchemy config validate agent.config.yaml --verbose",
      exitCode: 2,
      debugDetails: err instanceof Error ? err.stack : undefined,
    });
  }
  if (/Failed to parse YAML config:/i.test(message)) {
    return new TerminalError({
      code: "CONFIG_YAML_INVALID",
      title: "Invalid YAML config",
      cause: message,
      fix: "Check indentation and validate the config before starting the cockpit.",
      commandSuggestion: "balchemy config validate agent.config.yaml --verbose",
      exitCode: 2,
      debugDetails: err instanceof Error ? err.stack : undefined,
    });
  }
  if (/EACCES|permission denied/i.test(message)) {
    return new TerminalError({
      code: "FILE_PERMISSION_DENIED",
      title: "Cannot access file",
      cause: message,
      fix: "Choose a writable path or adjust permissions.",
      exitCode: 6,
      debugDetails: err instanceof Error ? err.stack : undefined,
    });
  }

  return new TerminalError({
    code: "RUNTIME_ERROR",
    title: "Command failed",
    cause: message,
    fix: "Run the command again with --debug for technical details, or run balchemy --help for usage.",
    commandSuggestion: "balchemy --help",
    exitCode: 1,
    retryable: false,
    debugDetails: err instanceof Error ? err.stack : undefined,
  });
}

export function terminalErrorToJson(error: TerminalError): JsonValue {
  return {
    code: error.code,
    title: error.title,
    cause: error.cause,
    fix: error.fix,
    commandSuggestion: error.commandSuggestion ?? null,
    docsHint: error.docsHint,
    exitCode: error.exitCode,
    retryable: error.retryable,
  };
}

export function renderTerminalError(reporter: Reporter, error: TerminalError): void {
  if (reporter.flags.json) return;

  reporter.error(`\n  ${C.ERR}${error.title}${C.R}\n`);
  reporter.error(`  ${C.D}Cause${C.R}  ${error.cause}\n`);
  reporter.error(`  ${C.D}Fix${C.R}    ${error.fix}\n`);
  if (error.commandSuggestion) {
    reporter.error(`  ${C.D}Command${C.R} ${C.W}${error.commandSuggestion}${C.R}\n`);
  }
  reporter.error(`  ${C.D}Help${C.R}    ${error.docsHint}\n`);
  reporter.error(`  ${C.D}Exit${C.R}    ${error.exitCode}\n`);
  if (reporter.flags.debug && error.debugDetails) {
    reporter.error(`\n${C.D}${error.debugDetails}${C.R}\n`);
  } else if (error.debugDetails) {
    reporter.error(`  ${C.D}Debug${C.R}   Re-run with --debug for technical details.\n`);
  }
  reporter.error("\n");
}
