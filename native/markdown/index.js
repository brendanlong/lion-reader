/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS loader for the .node binary */
"use strict";

/**
 * Loader for the native Markdown renderer. The .node artifact is produced by
 * `pnpm build:native` (see ../build.mjs); it is intentionally NOT committed.
 *
 * Same resolution strategy as @lion-reader/sanitizer's loader (see the comment
 * there for why static relative resolution breaks under bundlers): __dirname
 * covers every unbundled context, process.cwd() covers bundled contexts where
 * the app runs with cwd at the app root.
 *
 * Fail loud: there is no JS fallback renderer. A silent one would mean two
 * Markdown dialects to keep in sync, which is exactly what the single-instance
 * rule in CLAUDE.md exists to prevent.
 */

const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const path = require("node:path");

const candidates = [];
if (typeof __dirname === "string") {
  candidates.push(path.join(__dirname, "markdown.node"));
}
candidates.push(path.join(process.cwd(), "native", "markdown", "markdown.node"));

const binaryPath = candidates.find((candidate) => existsSync(candidate));
if (!binaryPath) {
  throw new Error(
    "Failed to load the native Markdown renderer (@lion-reader/markdown): no markdown.node at " +
      candidates.join(" or ") +
      ". Run `pnpm build:native` from the repo root to build it."
  );
}

const requireNative = createRequire(binaryPath);
const nativeBinding = requireNative(binaryPath);

// Static re-exports: see the sanitizer loader for why they're listed by name.
exports.renderMarkdown = nativeBinding.renderMarkdown;
exports.renderMarkdownAsync = nativeBinding.renderMarkdownAsync;

// Drift guard: see the sanitizer loader.
for (const key of Object.keys(exports)) {
  if (exports[key] === undefined) {
    throw new Error(
      `@lion-reader/markdown: re-exported "${key}" is undefined — markdown.node has no ` +
        `such export. Update the re-export list in index.js to match the built binary.`
    );
  }
}
