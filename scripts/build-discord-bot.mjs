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
});
