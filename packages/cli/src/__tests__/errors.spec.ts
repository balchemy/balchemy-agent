import test from "node:test";
import assert from "node:assert/strict";
import { terminalErrorToJson, toTerminalError, TerminalError } from "../errors.js";

test("toTerminalError maps missing config errors to structured CLI errors", () => {
  const error = toTerminalError(new Error("Config file not found: agent.config.yaml"));

  assert.equal(error.code, "CONFIG_FILE_MISSING");
  assert.equal(error.exitCode, 2);
  assert.match(error.fix, /balchemy init|config path/i);
});

test("terminalErrorToJson omits debug details from machine output", () => {
  const error = new TerminalError({
    code: "RUNTIME_ERROR",
    title: "Command failed",
    cause: "failed with sk-abcdefgh",
    fix: "Retry with --debug.",
    exitCode: 1,
    debugDetails: "stack with secret",
  });

  assert.deepEqual(terminalErrorToJson(error), {
    code: "RUNTIME_ERROR",
    title: "Command failed",
    cause: "failed with sk-abcdefgh",
    fix: "Retry with --debug.",
    commandSuggestion: null,
    docsHint: "Run balchemy --help for command usage.",
    exitCode: 1,
    retryable: false,
  });
});
