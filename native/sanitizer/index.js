/**
 * Loader for the native sanitizer. The .node artifact is produced by
 * `pnpm build:native` (see build.mjs); it is intentionally NOT committed.
 *
 * Fail loud: the sanitizer is the primary XSS defense, so there is no JS
 * fallback to silently diverge from. If the module is missing, the process
 * must not serve entry content.
 */
/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS loader for the .node binary */
"use strict";

try {
  module.exports = require("./sanitizer.node");
} catch (err) {
  throw new Error(
    "Failed to load the native sanitizer (@lion-reader/sanitizer). " +
      "Run `pnpm build:native` from the repo root to build it. " +
      `Underlying error: ${err && err.message}`
  );
}
