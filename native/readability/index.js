/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS loader for the .node binary */
"use strict";

/**
 * Loader for the native readability extractor. The .node artifact is produced
 * by `pnpm build:native` (see build.mjs); it is intentionally NOT committed.
 *
 * Same resolution strategy as @lion-reader/sanitizer's loader (see the comment
 * there for why static relative resolution breaks under bundlers): __dirname
 * covers every unbundled context, process.cwd() covers bundled contexts where
 * the app runs with cwd at the app root.
 *
 * Fail loud: extraction has no JS fallback anymore, and silently serving
 * uncleaned content would look like a Readability quality regression rather
 * than the build problem it actually is.
 */

const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const path = require("node:path");

const candidates = [];
if (typeof __dirname === "string") {
  candidates.push(path.join(__dirname, "readability.node"));
}
candidates.push(path.join(process.cwd(), "native", "readability", "readability.node"));

const binaryPath = candidates.find((candidate) => existsSync(candidate));
if (!binaryPath) {
  throw new Error(
    "Failed to load the native readability extractor (@lion-reader/readability): no readability.node at " +
      candidates.join(" or ") +
      ". Run `pnpm build:native` from the repo root to build it."
  );
}

const requireNative = createRequire(binaryPath);
const nativeBinding = requireNative(binaryPath);

// Static, lexable re-exports. Node's ESM loader discovers a CommonJS module's
// named exports via cjs-module-lexer, which only sees literal `exports.<name> =`
// assignments — not the dynamic binding object above. Without these,
// `import { extractArticle } from "@lion-reader/readability"` fails to resolve
// under the native ESM loader (e.g. the Playwright e2e harness).
exports.extractArticle = nativeBinding.extractArticle;
exports.extractArticleAsync = nativeBinding.extractArticleAsync;

// Completeness guard: if the .node binary grows a `#[napi]` export that isn't
// re-exported above, fail loudly at load rather than let ESM named imports of
// it silently break (a failure that would otherwise only surface under Node's
// ESM loader). Runs on every import — no separate drift-detecting test needed.
for (const key of Object.keys(nativeBinding)) {
  if (!(key in exports)) {
    throw new Error(
      `@lion-reader/readability: native binding exports "${key}" but index.js does not ` +
        `re-export it. Add \`exports.${key} = nativeBinding.${key};\` for ESM named-import support.`
    );
  }
}
