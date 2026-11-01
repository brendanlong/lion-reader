/**
 * Copies phonon-tts's worker and its single-threaded wasm build to
 * public/phonon/. The worker must load from our own origin: with
 * ASSET_PREFIX, a bundled worker would come from the CDN, and browsers refuse
 * a cross-origin worker script. Each version gets its own directory, so a
 * page loaded before a deploy keeps the worker it was built against. The
 * threaded build is left out because it needs a cross-origin isolated page,
 * which ours isn't.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(rootDir, "node_modules/phonon-tts");
const publicDir = join(rootDir, "public/phonon");

if (!existsSync(sourceDir)) {
  console.log("phonon-tts not yet installed, skipping copy");
  process.exit(0);
}

const { version } = JSON.parse(readFileSync(join(sourceDir, "package.json"), "utf8"));
const destDir = join(publicDir, version);
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(join(destDir, "wasm"), { recursive: true });
for (const file of readdirSync(sourceDir).filter((f) => f.endsWith(".js"))) {
  cpSync(join(sourceDir, file), join(destDir, file));
}
for (const file of readdirSync(join(sourceDir, "wasm"))) {
  if (file.endsWith(".js") || file.endsWith(".wasm")) {
    cpSync(join(sourceDir, "wasm", file), join(destDir, "wasm", file));
  }
}
console.log(`Copied the phonon-tts runtime to public/phonon/${version}/`);
