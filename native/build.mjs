/**
 * `node native/build.mjs [--debug]` builds every native crate in one cargo call
 * and copies each artifact next to its crate: native/<crate>/<crate>.node, or,
 * for a crate that is an executable (it has a src/main.rs),
 * native/<crate>/lion-reader-<crate>.
 *
 * We deliberately don't use @napi-rs/cli: a .node file is just the cdylib
 * renamed, and the TypeScript definitions are hand-maintained in index.d.ts.
 * This keeps the build a plain `cargo build` that works identically on dev
 * machines, CI, and the Alpine Docker builder.
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const debug = process.argv.includes("--debug");

/** The PDF helper has its own release profile; native/Cargo.toml says why. */
function profileFor(crate) {
  if (debug) return "debug";
  return crate === "pdf" ? "release-pdf" : "release";
}

/**
 * Copies `from` over `to` by renaming a fresh copy into place. Copying onto the
 * existing file would rewrite it in place, under any running process that has
 * it loaded (a dev server, a test run), which then crashes when it next touches
 * the changed pages. copyFileSync keeps the executable bit.
 */
function replaceFile(from, to) {
  if (!existsSync(from)) {
    throw new Error(`cargo build did not produce ${from}`);
  }
  const temp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, temp);
  renameSync(temp, to);
}

const cargoBuilds = debug
  ? ["--workspace"]
  : ["--release --workspace --exclude lion-reader-pdf", "--profile release-pdf -p lion-reader-pdf"];
for (const args of cargoBuilds) {
  execSync(`cargo build ${args}`, { cwd: root, stdio: "inherit" });
}

const crates = readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "Cargo.toml")))
  .map((entry) => entry.name);

for (const crate of crates) {
  const dir = join(root, crate);
  const profile = profileFor(crate);
  const targetDir = join(root, "target", profile);
  if (existsSync(join(dir, "src", "main.rs"))) {
    const name = `lion-reader-${crate}${process.platform === "win32" ? ".exe" : ""}`;
    replaceFile(join(targetDir, name), join(dir, name));
    console.log(`Built native ${crate} (${profile}) -> ${name}`);
    continue;
  }
  const lib = `lion_reader_${crate.replaceAll("-", "_")}`;
  const names = { linux: `lib${lib}.so`, darwin: `lib${lib}.dylib`, win32: `${lib}.dll` };
  const artifact = names[process.platform];
  if (!artifact) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }
  replaceFile(join(targetDir, artifact), join(dir, `${crate}.node`));
  console.log(`Built native ${crate} (${profile}) -> ${crate}.node`);
}
