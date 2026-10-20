#!/usr/bin/env node
/**
 * Bundles the backup-health Cloudflare Worker into the single ES module that
 * terraform/backup-health.tf uploads. Run before `terraform plan`.
 */

import { build } from "esbuild";
import { fileURLToPath } from "node:url";

/** @type {import("esbuild").BuildOptions} */
export const bundleOptions = {
  entryPoints: ["terraform/backup-health/index.ts"],
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  target: "es2022",
  minify: true,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build({ ...bundleOptions, outfile: "terraform/build/backup-health.js" });
}
