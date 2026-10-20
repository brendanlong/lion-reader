#!/usr/bin/env node
/**
 * Bundles the backup-health Cloudflare Worker into the single ES module that
 * terraform/backup-health.tf uploads. Run before `terraform plan`.
 */

import { build } from "esbuild";

await build({
  entryPoints: ["terraform/backup-health/worker.ts"],
  outfile: "terraform/build/backup-health.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  conditions: ["workerd", "worker", "browser"],
  target: "es2022",
  minify: true,
});
