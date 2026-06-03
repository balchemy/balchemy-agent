import test from "node:test";
import assert from "node:assert/strict";
import { buildStrategyUpdateArgs } from "../session-sync.js";

test("buildStrategyUpdateArgs stays shadow by default unless explicitly live", () => {
  assert.deepEqual(buildStrategyUpdateArgs("rules", true), {
    action: "configure_autonomous",
    naturalLanguageRules: "rules",
    shadowMode: true,
  });

  assert.equal(buildStrategyUpdateArgs("rules", false).shadowMode, false);
});
