import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildDockerPlan, generateDocker } from "../docker-gen.js";
import { TerminalError } from "../errors.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "balchemy-docker-test-"));
}

test("buildDockerPlan previews create actions for an empty directory", () => {
  const dir = tempDir();
  const plan = buildDockerPlan(dir);

  assert.equal(plan.outDir, dir);
  assert.equal(plan.hasOverwrites, false);
  assert.deepEqual(plan.files.map((file) => [file.filename, file.action, file.containsSecret]), [
    ["Dockerfile", "create", false],
    ["docker-compose.yml", "create", false],
    [".env.example", "create", false],
  ]);
});

test("generateDocker skips existing .env.example and blocks Docker overwrites without force", async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "Dockerfile"), "existing", "utf8");
  fs.writeFileSync(path.join(dir, ".env.example"), "keep", "utf8");

  const plan = buildDockerPlan(dir);
  assert.equal(plan.hasOverwrites, true);
  assert.equal(plan.files.find((file) => file.filename === ".env.example")?.action, "skip");

  await assert.rejects(
    () => generateDocker(dir),
    (error: unknown) => error instanceof TerminalError && error.code === "FILE_OVERWRITE_CONFIRMATION_REQUIRED",
  );
});
