/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS loader for the .node binary */
"use strict";

/**
 * Loader for the native feed parser. The .node artifact is produced by
 * `pnpm build:native` (see build.mjs); it is intentionally NOT committed.
 *
 * Same resolution strategy as @lion-reader/sanitizer's loader (see the comment
 * there for why static relative resolution breaks under bundlers): __dirname
 * covers every unbundled context, process.cwd() covers bundled contexts where
 * the app runs with cwd at the app root.
 *
 * Fail loud: feed parsing has no JS fallback, and a silent failure would look
 * like every feed breaking at once rather than the build problem it actually
 * is.
 */

const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const path = require("node:path");

const candidates = [];
if (typeof __dirname === "string") {
  candidates.push(path.join(__dirname, "feed-parser.node"));
}
candidates.push(path.join(process.cwd(), "native", "feed-parser", "feed-parser.node"));

const binaryPath = candidates.find((candidate) => existsSync(candidate));
if (!binaryPath) {
  throw new Error(
    "Failed to load the native feed parser (@lion-reader/feed-parser): no feed-parser.node at " +
      candidates.join(" or ") +
      ". Run `pnpm build:native` from the repo root to build it."
  );
}

const requireNative = createRequire(binaryPath);
const nativeBinding = requireNative(binaryPath);

// Static, lexable re-exports. Node's ESM loader discovers a CommonJS module's
// named exports via cjs-module-lexer, which only sees literal `exports.<name> =`
// assignments — not the dynamic binding object above. Without these,
// `import { parseRss } from "@lion-reader/feed-parser"` fails to resolve under
// the native ESM loader (e.g. the Playwright e2e harness).
exports.parseRss = nativeBinding.parseRss;
exports.parseAtom = nativeBinding.parseAtom;
exports.parseOpml = nativeBinding.parseOpml;
exports.parseRssAsync = nativeBinding.parseRssAsync;
exports.parseAtomAsync = nativeBinding.parseAtomAsync;
exports.parseOpmlAsync = nativeBinding.parseOpmlAsync;

// Drift guard: every name re-exported above must resolve to a real symbol in
// the binary. A re-export that comes out `undefined` means feed-parser.node has
// no such export — a `#[napi]` export was renamed/removed, or the list has a
// typo. Left unchecked, cjs-module-lexer still sees the name (so the import
// "succeeds") and it surfaces as a silent `undefined` that crashes only when
// the missing function is called. Fail loud at load instead. Runs on every import.
for (const key of Object.keys(exports)) {
  if (exports[key] === undefined) {
    throw new Error(
      `@lion-reader/feed-parser: re-exported "${key}" is undefined — feed-parser.node has no ` +
        `such export. Update the re-export list in index.js to match the built binary.`
    );
  }
}
