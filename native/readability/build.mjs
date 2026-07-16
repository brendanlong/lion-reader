/**
 * Builds the native readability extractor and copies the artifact to
 * ./readability.node.
 *
 * Same approach as native/sanitizer/build.mjs: no @napi-rs/cli — a .node file
 * is just the cdylib renamed, and the TypeScript definitions are
 * hand-maintained in index.d.ts. This keeps the build a plain `cargo build`
 * that works identically on dev machines, CI, and the Alpine Docker builder.
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
const debug = process.argv.includes("--debug");
const profile = debug ? "debug" : "release";

execSync(`cargo build${debug ? "" : " --release"}`, { cwd: dir, stdio: "inherit" });

const names = {
  linux: "liblion_reader_readability.so",
  darwin: "liblion_reader_readability.dylib",
  win32: "lion_reader_readability.dll",
};
const artifact = names[process.platform];
if (!artifact) {
  throw new Error(`Unsupported platform: ${process.platform}`);
}
const built = join(dir, "target", profile, artifact);
if (!existsSync(built)) {
  throw new Error(`cargo build did not produce ${built}`);
}
copyFileSync(built, join(dir, "readability.node"));
console.log(`Built native readability extractor (${profile}) -> readability.node`);
