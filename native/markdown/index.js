/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS loader for the .node binary */
"use strict";

/**
 * Loader for the native Markdown renderer. The .node artifact is produced by
 * `pnpm build:native` (see build.mjs); it is intentionally NOT committed.
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

// Static, lexable re-exports. Node's ESM loader discovers a CommonJS module's
// named exports via cjs-module-lexer, which only sees literal `exports.<name> =`
// assignments — not the dynamic binding object above. Without these,
// `import { renderMarkdown } from "@lion-reader/markdown"` fails to resolve
// under the native ESM loader (e.g. the Playwright e2e harness).
exports.renderMarkdown = nativeBinding.renderMarkdown;
exports.renderMarkdownAsync = nativeBinding.renderMarkdownAsync;

// Drift guard: every name re-exported above must resolve to a real symbol in
// the binary. A re-export that comes out `undefined` means markdown.node has no
// such export — a `#[napi]` export was renamed/removed, or the list has a typo.
// Left unchecked, cjs-module-lexer still sees the name (so the import
// "succeeds") and it surfaces as a silent `undefined` that crashes only when
// the missing function is called. Fail loud at load instead. Runs on every import.
for (const key of Object.keys(exports)) {
  if (exports[key] === undefined) {
    throw new Error(
      `@lion-reader/markdown: re-exported "${key}" is undefined — markdown.node has no ` +
        `such export. Update the re-export list in index.js to match the built binary.`
    );
  }
}
