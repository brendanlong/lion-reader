#!/usr/bin/env node
/**
 * Build script for bundling the custom server.
 *
 * Creates a single optimized JavaScript file that can run with just:
 *   node dist/server.js
 *
 * The server wraps Next.js with streaming compression (zstd/brotli/gzip).
 */

import { buildBundle } from "./build-bundle.mjs";

await buildBundle({
  label: "Server",
  entryPoint: "scripts/server.ts",
  outfile: "dist/server.js",

  // External packages that can't/shouldn't be bundled:
  // - next: loaded from node_modules at runtime (needs .next build output)
  // - Native modules (argon2 uses node-gyp bindings)
  // - html-rewriter-wasm has WASM files and internal requires that break when bundled
  external: [
    "next",
    "argon2",
    "html-rewriter-wasm",
    "@lion-reader/sanitizer",
    "@lion-reader/readability",
    "@lion-reader/feed-parser",
    "@lion-reader/markdown",
  ],
});
