import test from "node:test";
import assert from "node:assert/strict";
import { buildBrowserOpenCommand } from "../browser.js";

test("buildBrowserOpenCommand uses argument arrays without shell commands", () => {
  assert.deepEqual(buildBrowserOpenCommand("https://example.test/path?q=1", "darwin"), {
    command: "open",
    args: ["https://example.test/path?q=1"],
  });
  assert.deepEqual(buildBrowserOpenCommand("https://example.test/path?q=1", "linux"), {
    command: "xdg-open",
    args: ["https://example.test/path?q=1"],
  });
});

test("buildBrowserOpenCommand rejects non-local http URLs", () => {
  assert.throws(
    () => buildBrowserOpenCommand("http://example.test/path", "linux"),
    /https or localhost/,
  );
});
