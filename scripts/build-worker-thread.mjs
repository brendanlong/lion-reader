#!/usr/bin/env node
/**
 * Build script for the worker-thread bundle.
 *
 * Compiles the piscina worker entry point into a single JS file so that
 * worker threads in production don't need tsx or the full source tree.
 *
 *   node dist/worker-thread.js   (loaded by piscina, not run directly)
 */

import * as esbuild from "esbuild";
import { readFileSync, statSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

// Read tsconfig to get path aliases
const tsconfig = JSON.parse(readFileSync(resolve(rootDir, "tsconfig.json"), "utf8"));
const paths = tsconfig.compilerOptions?.paths || {};

// Convert TypeScript path aliases to esbuild alias format
const alias = {};
for (const [key, values] of Object.entries(paths)) {
  const aliasKey = key.replace("/*", "");
  const aliasValue = values[0].replace("/*", "");
  alias[aliasKey] = resolve(rootDir, aliasValue);
}

const buildOptions = {
  entryPoints: [resolve(rootDir, "src/server/worker-thread/worker.ts")],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  outfile: resolve(rootDir, "dist/worker-thread.js"),

  alias,

  // html-rewriter-wasm has WASM files that break when bundled.
  // Everything else (linkedom, @mozilla/readability, htmlparser2, etc.) is bundled.
  external: ["html-rewriter-wasm"],

  sourcemap: true,
  minify: true,
  keepNames: true,
  treeShaking: true,

  define: {
    "process.env.NODE_ENV": '"production"',
  },

  logLevel: "info",
};

async function build() {
  console.log("Building worker-thread bundle...");
  const startTime = Date.now();

  try {
    const result = await esbuild.build(buildOptions);

    const duration = Date.now() - startTime;
    console.log(`Worker-thread bundle built in ${duration}ms`);

    if (result.warnings.length > 0) {
      console.warn("Warnings:", result.warnings);
    }

    const stats = statSync(resolve(rootDir, "dist/worker-thread.js"));
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`Bundle size: ${sizeMB} MB`);
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
