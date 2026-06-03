import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config-loader.js";

function writeConfig(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "balchemy-config-"));
  const file = path.join(dir, "agent.config.yaml");
  fs.writeFileSync(file, body, "utf8");
  return file;
}

test("loadConfig defaults shadowMode to true", () => {
  const file = writeConfig(`mcp_endpoint: "https://api.balchemy.ai/mcp/pub"
api_key: "key"
llm:
  provider: openai
  api_key: "llm"
`);

  assert.equal(loadConfig(file).shadowMode, true);
});

test("loadConfig preserves explicit shadow_mode false", () => {
  const file = writeConfig(`mcp_endpoint: "https://api.balchemy.ai/mcp/pub"
api_key: "key"
shadow_mode: false
llm:
  provider: openai
  api_key: "llm"
`);

  assert.equal(loadConfig(file).shadowMode, false);
});
