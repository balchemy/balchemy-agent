import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertSafeInitDirectory,
  isBalchemySourceCheckout,
} from "../init-target.js";
import { TerminalError } from "../errors.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "balchemy-init-target-"));
}

test("init target allows ordinary agent directories", () => {
  const dir = makeTempDir();

  assert.equal(isBalchemySourceCheckout(dir), false);
  assert.doesNotThrow(() => assertSafeInitDirectory(dir));
});

test("init target blocks the Balchemy source checkout", () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "rules", "utf8");
  fs.mkdirSync(path.join(dir, "balchemy-backend"));
  fs.mkdirSync(path.join(dir, "balchemy-frontend-v2"));
  fs.mkdirSync(path.join(dir, "create-balchemy-agent"));

  assert.equal(isBalchemySourceCheckout(dir), true);
  assert.throws(
    () => assertSafeInitDirectory(dir),
    (error: unknown) =>
      error instanceof TerminalError &&
      error.code === "UNSAFE_INIT_DIRECTORY" &&
      /separate agent directory/i.test(error.fix),
  );
});
