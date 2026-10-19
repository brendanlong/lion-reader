#!/usr/bin/env node
/**
 * Build script for bundling the background worker.
 *
 * Creates a single optimized JavaScript file that can run with just:
 *   node dist/worker.js
 *
 * This eliminates the need for tsx, TypeScript compilation at runtime,
 * and most of node_modules in the production Docker image.
 */

import { buildBundle } from "./build-bundle.mjs";

await buildBundle({
  label: "Worker",
  entryPoint: "scripts/worker.ts",
  outfile: "dist/worker.js",
});
