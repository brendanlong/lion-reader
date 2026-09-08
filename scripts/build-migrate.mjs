#!/usr/bin/env node
/**
 * Build script for bundling the migration script.
 *
 * Creates a single optimized JavaScript file that can run with just:
 *   node dist/migrate.js
 *
 * This eliminates the need for tsx, dotenv, and pnpm in the production Docker image.
 */

import { buildBundle } from "./build-bundle.mjs";

await buildBundle({
  label: "Migration",
  entryPoint: "scripts/migrate.ts",
  outfile: "dist/migrate.js",

  // No external dependencies needed - pg and ioredis can be bundled
  external: [],
});
