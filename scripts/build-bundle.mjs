/**
 * Shared esbuild driver for the deployable bundles (server, worker, Discord bot,
 * migrate). Each `build-*.mjs` is just an entry point + outfile + its own
 * `external` list; everything else — path-alias resolution, esbuild options,
 * the CommonJS marker, error handling — lives here so the four can't drift.
 *
 * Bundles are emitted as CommonJS on purpose; see the "Module System (ESM)"
 * section of CLAUDE.md and scripts/dist-cjs-marker.mjs before changing `format`.
 */

import * as esbuild from "esbuild";
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDistCjsMarker } from "./dist-cjs-marker.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Convert the TypeScript path aliases in tsconfig.json to esbuild's alias map,
 * so bundled imports resolve the way `tsc` resolves them: `"@/*" -> "./src/*"`
 * becomes `"@" -> "<rootDir>/src"`.
 */
function tsconfigAliases() {
  const tsconfig = JSON.parse(readFileSync(resolve(rootDir, "tsconfig.json"), "utf8"));
  const paths = tsconfig.compilerOptions?.paths || {};

  const alias = {};
  for (const [key, values] of Object.entries(paths)) {
    alias[key.replace("/*", "")] = resolve(rootDir, values[0].replace("/*", ""));
  }
  return alias;
}

function formatSize(bytes) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(2)} KB`;
}

/**
 * Bundle one entry point and exit non-zero if esbuild fails.
 *
 * @param {object} options
 * @param {string} options.label Human-readable name used in the build logs.
 * @param {string} options.entryPoint Entry file, relative to the repo root.
 * @param {string} options.outfile Output file, relative to the repo root.
 * @param {string[]} [options.external] Packages to leave as runtime requires.
 */
export async function buildBundle({ label, entryPoint, outfile, external = [] }) {
  console.log(`Building ${label} bundle...`);
  const startTime = Date.now();
  const outPath = resolve(rootDir, outfile);

  try {
    const result = await esbuild.build({
      entryPoints: [resolve(rootDir, entryPoint)],
      bundle: true,
      platform: "node",
      target: "node26",
      format: "cjs",
      outfile: outPath,

      // Resolve TypeScript path aliases
      alias: tsconfigAliases(),

      external,

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
    });
    writeDistCjsMarker(dirname(outPath));

    console.log(`${label} bundle built in ${Date.now() - startTime}ms`);

    if (result.warnings.length > 0) {
      console.warn("Warnings:", result.warnings);
    }

    console.log(`Bundle size: ${formatSize(statSync(outPath).size)}`);
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}
