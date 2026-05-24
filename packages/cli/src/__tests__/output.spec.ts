import test from "node:test";
import assert from "node:assert/strict";
import { jsonEnvelope, redactJsonValue, redactSecrets } from "../output.js";

test("redactSecrets removes token values without preserving captured secrets", () => {
  const text = "sk-abcdefgh key-abcdefgh balc_abcdefgh Bearer abc.def?token=secret api=https://x.test?api_key=abc123";
  const redacted = redactSecrets(text);

  assert.equal(redacted.includes("sk-abcdefgh"), false);
  assert.equal(redacted.includes("key-abcdefgh"), false);
  assert.equal(redacted.includes("balc_abcdefgh"), false);
  assert.equal(redacted.includes("Bearer abc.def"), false);
  assert.equal(redacted.includes("token=secret"), false);
  assert.equal(redacted.includes("api_key=abc123"), false);
  assert.match(redacted, /Bearer \[redacted\]/);
  assert.match(redacted, /api_key=\[redacted\]/);
});

test("redactJsonValue recursively redacts JSON strings", () => {
  const redacted = redactJsonValue({
    ok: false,
    error: {
      cause: "failed with Bearer secret-token and balc_abcdefgh",
      nested: ["sk-abcdefgh"],
    },
  });

  assert.deepEqual(redacted, {
    ok: false,
    error: {
      cause: "failed with Bearer [redacted] and [redacted]",
      nested: ["[redacted]"],
    },
  });
});

test("jsonEnvelope returns stable top-level machine output shape", () => {
  assert.deepEqual(Object.keys(jsonEnvelope({ ok: true, command: "version", version: "0.0.0" })), [
    "ok",
    "command",
    "version",
    "data",
    "warnings",
    "error",
  ]);
});
