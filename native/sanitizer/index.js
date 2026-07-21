/* eslint-disable @typescript-eslint/no-require-imports -- plain CJS loader for the .node binary */
"use strict";

/**
 * Loader for the native sanitizer. The .node artifact is produced by
 * `pnpm build:native` (see build.mjs); it is intentionally NOT committed.
 *
 * The binary is resolved at runtime through `createRequire` with an
 * existence-checked candidate list rather than a static
 * `require("./sanitizer.node")`: bundlers (Next's turbopack dev server in
 * particular) inline this loader even for external/workspace packages, which
 * breaks static relative resolution. `__dirname` covers every unbundled
 * context (tsx, vitest, the esbuild bundles that mark this package external);
 * `process.cwd()` covers bundled contexts, where the app always runs with
 * cwd at the app root (dev, prod Docker WORKDIR, CI) — mirroring
 * `resolveWorkerPath` in src/server/worker-thread/pool.ts.
 *
 * Fail loud: the sanitizer is the primary XSS defense, so there is no JS
 * fallback to silently diverge from. If the module is missing, the process
 * must not serve entry content.
 */

const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const path = require("node:path");

const candidates = [];
if (typeof __dirname === "string") {
  candidates.push(path.join(__dirname, "sanitizer.node"));
}
candidates.push(path.join(process.cwd(), "native", "sanitizer", "sanitizer.node"));

const binaryPath = candidates.find((candidate) => existsSync(candidate));
if (!binaryPath) {
  throw new Error(
    "Failed to load the native sanitizer (@lion-reader/sanitizer): no sanitizer.node at " +
      candidates.join(" or ") +
      ". Run `pnpm build:native` from the repo root to build it."
  );
}

const requireNative = createRequire(binaryPath);
const nativeBinding = requireNative(binaryPath);

// Static, lexable re-exports. Node's ESM loader discovers a CommonJS module's
// named exports via cjs-module-lexer, which only sees literal `exports.<name> =`
// assignments — not the dynamic binding object above. Without these,
// `import { sanitizeEntryHtml } from "@lion-reader/sanitizer"` fails to resolve
// under the native ESM loader (e.g. the Playwright e2e harness).
exports.SANITIZER_VERSION = nativeBinding.SANITIZER_VERSION;
exports.sanitizeEntryHtml = nativeBinding.sanitizeEntryHtml;
exports.sanitizeEntryHtmlAsync = nativeBinding.sanitizeEntryHtmlAsync;
exports.embedCanonicalHostnames = nativeBinding.embedCanonicalHostnames;
exports.normalizeEmbed = nativeBinding.normalizeEmbed;

// Completeness guard: if the .node binary grows a `#[napi]` export that isn't
// re-exported above, fail loudly at load rather than let ESM named imports of
// it silently break (a failure that would otherwise only surface under Node's
// ESM loader). Runs on every import — no separate drift-detecting test needed.
for (const key of Object.keys(nativeBinding)) {
  if (!(key in exports)) {
    throw new Error(
      `@lion-reader/sanitizer: native binding exports "${key}" but index.js does not ` +
        `re-export it. Add \`exports.${key} = nativeBinding.${key};\` for ESM named-import support.`
    );
  }
}
