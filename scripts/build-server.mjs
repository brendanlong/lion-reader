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
  // next is loaded from node_modules at runtime (it needs the .next build output).
  external: ["next"],
});
