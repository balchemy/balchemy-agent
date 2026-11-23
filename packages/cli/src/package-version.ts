import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** This package's version from its own package.json (dist/package-version.js -> ../package.json). The CLI and the runner
 * daemon read the same file, so after an upgrade a still-running older daemon reports a different value. */
export const PACKAGE_VERSION: string = (() => {
  try {
    const manifest = require("../package.json") as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : "unknown";
  } catch { return "unknown"; }
})();
