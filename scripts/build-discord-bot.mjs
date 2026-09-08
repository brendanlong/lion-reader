#!/usr/bin/env node
/**
 * Build script for bundling the Discord bot.
 *
 * Creates a single optimized JavaScript file that can run with just:
 *   node dist/discord-bot.js
 *
 * This eliminates the need for tsx, TypeScript compilation at runtime,
 * and most of node_modules in the production Docker image.
 */

import { buildBundle } from "./build-bundle.mjs";

await buildBundle({
  label: "Discord bot",
  entryPoint: "scripts/discord-bot.ts",
  outfile: "dist/discord-bot.js",

  // External packages that can't/shouldn't be bundled:
  // - Native modules (argon2 uses node-gyp bindings)
  // - html-rewriter-wasm has WASM files and internal requires that break when bundled
  // We bundle everything else for a smaller, faster deployment
  external: [
    "argon2",
    "html-rewriter-wasm",
    "@lion-reader/sanitizer",
    "@lion-reader/readability",
    "@lion-reader/feed-parser",
    "@lion-reader/markdown",
  ],
});
