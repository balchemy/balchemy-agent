import test from "node:test";
import assert from "node:assert/strict";
import { commandKey, parseCliArgs } from "../cli-options.js";

test("parseCliArgs parses global flags and nested agent commands", () => {
  const parsed = parseCliArgs(["agent", "current", "--json", "--ci"]);

  assert.equal(commandKey(parsed.commandPath), "agent current");
  assert.deepEqual(parsed.args, []);
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.ci, true);
  assert.deepEqual(parsed.unknownFlags, []);
});

test("parseCliArgs treats docker generate as docker command alias", () => {
  const parsed = parseCliArgs(["docker", "generate", "./deploy", "--dry-run"]);

  assert.equal(commandKey(parsed.commandPath), "docker");
  assert.deepEqual(parsed.args, ["./deploy"]);
  assert.equal(parsed.flags.dryRun, true);
});

test("parseCliArgs records unsupported flags without dropping command args", () => {
  const parsed = parseCliArgs(["config", "validate", "agent.config.yaml", "--wat"]);

  assert.equal(commandKey(parsed.commandPath), "config validate");
  assert.deepEqual(parsed.args, ["agent.config.yaml"]);
  assert.deepEqual(parsed.unknownFlags, ["--wat"]);
});

test("parseCliArgs maps explicit context and tui aliases", () => {
  const context = parseCliArgs(["context", "current", "--json"]);
  const tui = parseCliArgs(["tui", "./agent.config.yaml"]);

  assert.equal(commandKey(context.commandPath), "agent current");
  assert.equal(context.flags.json, true);
  assert.equal(commandKey(tui.commandPath), "start");
  assert.deepEqual(tui.args, ["./agent.config.yaml"]);
});

test("parseCliArgs keeps auth login and logout grouped", () => {
  const login = parseCliArgs(["auth", "login", "--dry-run"]);
  const logout = parseCliArgs(["auth", "logout", "--force"]);

  assert.equal(commandKey(login.commandPath), "auth login");
  assert.equal(login.flags.dryRun, true);
  assert.equal(commandKey(logout.commandPath), "auth logout");
  assert.equal(logout.flags.force, true);
});
