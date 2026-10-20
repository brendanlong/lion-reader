/**
 * `node native/build.mjs <crate> [--debug]` builds native/<crate> and copies
 * the artifact to native/<crate>/<crate>.node — or, for a crate that is an
 * executable (it has a src/main.rs), to native/<crate>/lion-reader-<crate>.
 *
 * We deliberately don't use @napi-rs/cli: a .node file is just the cdylib
 * renamed, and the TypeScript definitions are hand-maintained in index.d.ts.
 * This keeps the build a plain `cargo build` that works identically on dev
 * machines, CI, and the Alpine Docker builder.
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const crate = process.argv[2];
const dir = join(dirname(fileURLToPath(import.meta.url)), crate ?? "");
if (!crate || !existsSync(join(dir, "Cargo.toml"))) {
  throw new Error("Usage: node native/build.mjs <crate> [--debug]");
}
const debug = process.argv.includes("--debug");

/**
 * Copies `from` over `to` by renaming a fresh copy into place. Copying onto the
 * existing file would rewrite it in place, under any running process that has
 * it loaded (a dev server, a test run), which then crashes when it next touches
 * the changed pages. copyFileSync keeps the executable bit.
 */
function replaceFile(from, to) {
  const temp = `${to}.${process.pid}.tmp`;
  copyFileSync(from, temp);
  renameSync(temp, to);
}
const profile = debug ? "debug" : "release";

execSync(`cargo build${debug ? "" : " --release"}`, { cwd: dir, stdio: "inherit" });

if (existsSync(join(dir, "src", "main.rs"))) {
  const name = `lion-reader-${crate}${process.platform === "win32" ? ".exe" : ""}`;
  const built = join(dir, "target", profile, name);
  if (!existsSync(built)) {
    throw new Error(`cargo build did not produce ${built}`);
  }
  replaceFile(built, join(dir, name));
  console.log(`Built native ${crate} (${profile}) -> ${name}`);
  process.exit(0);
}

const lib = `lion_reader_${crate.replaceAll("-", "_")}`;
const names = { linux: `lib${lib}.so`, darwin: `lib${lib}.dylib`, win32: `${lib}.dll` };
const artifact = names[process.platform];
if (!artifact) {
  throw new Error(`Unsupported platform: ${process.platform}`);
}
const built = join(dir, "target", profile, artifact);
if (!existsSync(built)) {
  throw new Error(`cargo build did not produce ${built}`);
}
replaceFile(built, join(dir, `${crate}.node`));
console.log(`Built native ${crate} (${profile}) -> ${crate}.node`);
