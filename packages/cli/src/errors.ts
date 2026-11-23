import { C } from "./colors.js";
import type { JsonValue, Reporter } from "./output.js";

export type TerminalErrorCode =
  | "UNKNOWN_COMMAND"
  | "UNKNOWN_FLAG"
  | "FILE_PERMISSION_DENIED"
  | "CI_PROMPT_BLOCKED"
  | "TERMINAL_UNSUPPORTED_TUI"
  | "RUNTIME_OUTCOME_UNKNOWN"
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
  operationId?: string;
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
  readonly operationId?: string;

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
    this.operationId = params.operationId;
  }
}

export function toTerminalError(err: unknown): TerminalError {
  if (err instanceof TerminalError) return err;

  const message = err instanceof Error ? err.message : String(err);
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
    ...(error.operationId ? { operationId: error.operationId } : {}),
  };
}

export function renderTerminalError(reporter: Reporter, error: TerminalError): void {
  if (reporter.flags.json) return;

  reporter.error(`\n  ${C.ERR}${error.title}${C.R}\n`);
  reporter.error(`  ${C.D}Cause${C.R}  ${error.cause}\n`);
  reporter.error(`  ${C.D}Fix${C.R}    ${error.fix}\n`);
  if (error.operationId) {
    reporter.error(`  ${C.D}Operation${C.R} ${error.operationId}\n`);
  }
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
