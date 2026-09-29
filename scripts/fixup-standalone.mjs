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
 * 2b. mammoth, which nothing imports statically: the .docx converter
 *    (src/server/file/docx-to-html.ts) requires it from inside an eval'd worker
 *    thread. Copy it with its whole dependency closure, pnpm links included.
 *    Nothing else would notice if that copy were incomplete — the converter
 *    would just fail at runtime — so step 4 converts a document with it.
 *
 * 3. The @lion-reader workspace symlinks: the trace resolves them to their
 *    real paths under native/, so no node_modules/@lion-reader entries exist.
 *    Recreate the symlinks; the Dockerfile copies the actual native module
 *    files (index.js + the musl .node binaries) into the runner's native/.
 *
 * 4. Load mammoth from the standalone tree, the way the converter does, and
 *    convert a small document; fail the build if that breaks.
 *
 * Run after `pnpm build` (needs the full node_modules to copy from).
 */

import {
  cpSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
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

// 1. Copy whole packages whose dynamic requires the trace misses. Remove the
// traced subset first: cpSync's `force` doesn't overwrite when the file type
// differs (e.g. symlink vs regular file) and throws EEXIST instead.
for (const pkg of ["html-rewriter-wasm", "argon2"]) {
  const realDir = packageDir(pkg);
  const dest = standalonePath(realDir);
  rmSync(dest, { recursive: true, force: true });
  cpSync(realDir, dest, { recursive: true });
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

// 2b. Copy mammoth and its dependency closure. Under pnpm each package's real
// directory sits at `.pnpm/<id>/node_modules/<name>`, next to symlinks to every
// dependency pnpm resolved for it (regular, optional and peer alike); recreate
// all of those links and recurse through their targets.
/** Replace `link` in the standalone tree with the same (relative) symlink. */
function copySymlink(link) {
  const dest = standalonePath(link);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(readlinkSync(link), dest);
}

function copyPackageClosure(name, realDir, copied = new Set()) {
  if (copied.has(realDir)) return;
  copied.add(realDir);
  const dest = standalonePath(realDir);
  rmSync(dest, { recursive: true, force: true });
  cpSync(realDir, dest, { recursive: true });

  const nodeModulesDir = realDir.slice(0, -name.length);
  for (const dep of linkedDependencies(nodeModulesDir)) {
    const link = join(nodeModulesDir, dep);
    copySymlink(link);
    copyPackageClosure(dep, realpathSync(link), copied);
  }
}

/** Names of the dependency symlinks in a pnpm `.pnpm/<id>/node_modules` dir. */
function linkedDependencies(nodeModulesDir) {
  const names = [];
  for (const entry of readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      names.push(entry.name);
    } else if (entry.isDirectory() && entry.name.startsWith("@")) {
      for (const scoped of readdirSync(join(nodeModulesDir, entry.name), { withFileTypes: true })) {
        if (scoped.isSymbolicLink()) names.push(`${entry.name}/${scoped.name}`);
      }
    }
  }
  return names;
}

copySymlink(join(rootDir, "node_modules", "mammoth"));
copyPackageClosure("mammoth", packageDir("mammoth"));
console.log("Copied mammoth and its dependencies");

// 3. Recreate the @lion-reader workspace symlinks.
const scopeDir = join(standaloneDir, "node_modules", "@lion-reader");
mkdirSync(scopeDir, { recursive: true });
for (const name of ["sanitizer", "readability", "feed-parser", "markdown"]) {
  const link = join(scopeDir, name);
  rmSync(link, { recursive: true, force: true });
  symlinkSync(join("..", "..", "native", name), link);
}
console.log("Created @lion-reader symlinks");

// 4. Convert a document with the standalone mammoth, resolved the way the
// worker resolves it (from the app root's node_modules). The document is built
// with the jszip mammoth itself depends on, so this needs nothing else.
const standaloneRequire = createRequire(join(standaloneDir, "package.json"));
try {
  const mammoth = standaloneRequire("mammoth");
  const JSZip = createRequire(standaloneRequire.resolve("mammoth"))("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/></Types>'
  );
  zip.file(
    "_rels/.rels",
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>"
  );
  zip.file(
    "word/document.xml",
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>standalone smoke test</w:t></w:r></w:p></w:body></w:document>"
  );
  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const { value } = await mammoth.convertToHtml({ buffer });
  if (value !== "<p>standalone smoke test</p>") {
    throw new Error(`unexpected output: ${value}`);
  }
  // Resolution walks up out of the standalone tree into the repo's own
  // node_modules (where mammoth is a direct dependency), so a successful
  // conversion alone doesn't prove the copy is complete: every module it
  // loaded must have come from inside the standalone tree.
  const standaloneRoot = realpathSync(standaloneDir) + sep;
  const outside = Object.keys(standaloneRequire.cache).filter(
    (path) => !path.startsWith(standaloneRoot)
  );
  if (outside.length > 0) {
    throw new Error(
      `loaded ${outside.length} module(s) from outside the standalone tree, e.g. ${outside[0]}`
    );
  }
} catch (error) {
  console.error("The standalone tree can't convert a .docx with mammoth:", error);
  process.exit(1);
}
console.log("Converted a .docx with the standalone mammoth");
