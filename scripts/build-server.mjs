#!/usr/bin/env node
/**
 * Build script for bundling the custom server.
 *
 * Creates a single optimized JavaScript file that can run with just:
 *   node dist/server.js
 *
 * The server wraps Next.js with streaming compression (zstd/brotli/gzip).
 */

import * as esbuild from "esbuild";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, "..");

// Read tsconfig to get path aliases
const tsconfig = JSON.parse(readFileSync(resolve(rootDir, "tsconfig.json"), "utf8"));
const paths = tsconfig.compilerOptions?.paths || {};

// Convert TypeScript path aliases to esbuild alias format
// "@/*" -> "./src/*" becomes "@" -> "./src"
const alias = {};
for (const [key, values] of Object.entries(paths)) {
  const aliasKey = key.replace("/*", "");
  const aliasValue = values[0].replace("/*", "");
  alias[aliasKey] = resolve(rootDir, aliasValue);
}

// Build configuration
const buildOptions = {
  entryPoints: [resolve(rootDir, "scripts/server.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile: resolve(rootDir, "dist/server.js"),

  // Resolve TypeScript path aliases
  alias,

  // External packages that can't/shouldn't be bundled:
  // - next: loaded from node_modules at runtime (needs .next build output)
  // - Native modules (argon2 uses node-gyp bindings)
  // - html-rewriter-wasm has WASM files and internal requires that break when bundled
  external: ["next", "argon2", "html-rewriter-wasm"],

  // Source maps for debugging production issues
  sourcemap: true,

  // Minify for smaller bundle size
  minify: true,

  // Keep names for better error stack traces
  keepNames: true,

  // Tree-shake unused code
  treeShaking: true,

  // Define environment for dead code elimination
  define: {
    "process.env.NODE_ENV": '"production"',
  },

  // Banner to make the output executable
  banner: {
    js: "#!/usr/bin/env node",
  },

  // Log level
  logLevel: "info",
};

async function build() {
  console.log("Building server bundle...");
  const startTime = Date.now();

  try {
    const result = await esbuild.build(buildOptions);

    const duration = Date.now() - startTime;
    console.log(`Server bundle built in ${duration}ms`);

    if (result.warnings.length > 0) {
      console.warn("Warnings:", result.warnings);
    }

    // Report bundle size
    const { statSync } = await import("fs");
    const stats = statSync(resolve(rootDir, "dist/server.js"));
    const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
    console.log(`Bundle size: ${sizeMB} MB`);
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

build();
