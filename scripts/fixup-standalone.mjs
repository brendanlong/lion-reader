#!/usr/bin/env node
/**
 * Fix up Next's standalone output (.next/standalone) for the production image.
 *
 * `output: "standalone"` traces the server build with @vercel/nft and emits a
 * minimal node_modules, which the Dockerfile ships instead of the full pruned
 * tree (issue #1305). The trace misses a few things our runtime needs:
 *
 * 1. Packages with dynamic requires nft can't follow statically:
 *    - html-rewriter-wasm: dist/html_rewriter.js requires ./asyncify.js at
 *      runtime; the trace only picks up the wasm + entry file.
 *    - argon2: the prebuild is resolved per-platform/libc at runtime
 *      (prebuilds/linux-x64/argon2.{glibc,musl}.node); the trace only includes
 *      the variant matching the machine the build ran on.
 *    Copy the whole (small) packages over the traced subset.
 *
 * 2. next's top-level subpath shims (constants.js etc., one-line re-exports
 *    into dist/): dist/server.js requires `next/constants`, whose target IS
 *    traced but the shim file itself isn't.
 *
 * 3. The @lion-reader workspace symlinks: the trace resolves them to their
 *    real paths under native/, so no node_modules/@lion-reader entries exist.
 *    Recreate the symlinks; the Dockerfile copies the actual native module
 *    files (index.js + the musl .node binaries) into the runner's native/.
 *
 * Run after `pnpm build` (needs the full node_modules to copy from).
 */

import { cpSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDir = join(rootDir, ".next", "standalone");
const require = createRequire(join(rootDir, "package.json"));

/** Real (symlink-resolved) directory of an installed package. */
function packageDir(name) {
  return realpathSync(dirname(require.resolve(`${name}/package.json`)));
}

/** The standalone tree mirrors the repo layout, so reuse the relative path. */
function standalonePath(realDir) {
  return join(standaloneDir, relative(rootDir, realDir));
}

// 1. Copy whole packages whose dynamic requires the trace misses.
for (const pkg of ["html-rewriter-wasm", "argon2"]) {
  const realDir = packageDir(pkg);
  cpSync(realDir, standalonePath(realDir), { recursive: true, force: true });
  console.log(`Copied full package: ${pkg}`);
}

// 2. Copy next's top-level subpath shims (constants.js etc.).
const nextDir = packageDir("next");
const standaloneNextDir = standalonePath(nextDir);
for (const file of readdirSync(nextDir)) {
  if (file.endsWith(".js")) {
    cpSync(join(nextDir, file), join(standaloneNextDir, file), { force: true });
  }
}
console.log("Copied next's top-level subpath shims");

// 3. Recreate the @lion-reader workspace symlinks.
const scopeDir = join(standaloneDir, "node_modules", "@lion-reader");
mkdirSync(scopeDir, { recursive: true });
for (const name of ["sanitizer", "readability", "feed-parser"]) {
  const link = join(scopeDir, name);
  rmSync(link, { recursive: true, force: true });
  symlinkSync(join("..", "..", "native", name), link);
}
console.log("Created @lion-reader symlinks");
