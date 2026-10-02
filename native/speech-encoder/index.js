/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS loader for the .node binary */
"use strict";

/**
 * Loader for the native speech encoder. The .node artifact is produced by
 * `pnpm build:native` (see ../build.mjs); it is intentionally NOT committed.
 *
 * Same resolution strategy as @lion-reader/sanitizer's loader (see the comment
 * there for why static relative resolution breaks under bundlers): __dirname
 * covers every unbundled context, process.cwd() covers bundled contexts where
 * the app runs with cwd at the app root.
 */

const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const path = require("node:path");

const candidates = [];
if (typeof __dirname === "string") {
  candidates.push(path.join(__dirname, "speech-encoder.node"));
}
candidates.push(path.join(process.cwd(), "native", "speech-encoder", "speech-encoder.node"));

const binaryPath = candidates.find((candidate) => existsSync(candidate));
if (!binaryPath) {
  throw new Error(
    "Failed to load the native speech encoder (@lion-reader/speech-encoder): no speech-encoder.node at " +
      candidates.join(" or ") +
      ". Run `pnpm build:native` from the repo root to build it."
  );
}

const requireNative = createRequire(binaryPath);
const nativeBinding = requireNative(binaryPath);

// Static re-exports: see the sanitizer loader for why they're listed by name.
exports.SpeechEncoder = nativeBinding.SpeechEncoder;

// Drift guard: see the sanitizer loader.
for (const key of Object.keys(exports)) {
  if (exports[key] === undefined) {
    throw new Error(
      `@lion-reader/speech-encoder: re-exported "${key}" is undefined — speech-encoder.node has no ` +
        `such export. Update the re-export list in index.js to match the built binary.`
    );
  }
}
