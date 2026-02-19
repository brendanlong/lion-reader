/**
 * Copy ONNX Runtime WASM files to public folder.
 *
 * The piper-tts-web library defaults to loading ONNX WASM from a CDN that
 * returns 404 errors. We work around this by serving the WASM files locally.
 */

import { copyFileSync, mkdirSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");

const sourceDir = join(rootDir, "node_modules/onnxruntime-web/dist");
const destDir = join(rootDir, "public/onnx");

// Create destination directory if it doesn't exist
mkdirSync(destDir, { recursive: true });

// Check if source directory exists (might not during CI or fresh clone)
if (!existsSync(sourceDir)) {
  console.log("ONNX Runtime not yet installed, skipping WASM copy");
  process.exit(0);
}

// Copy .wasm files and their companion .mjs files (used by onnxruntime-web >= 1.24)
const filesToCopy = readdirSync(sourceDir).filter(
  (f) => f.startsWith("ort-wasm-simd-threaded") && (f.endsWith(".wasm") || f.endsWith(".mjs"))
);

for (const file of filesToCopy) {
  const src = join(sourceDir, file);
  const dest = join(destDir, file);
  copyFileSync(src, dest);
  console.log(`Copied ${file} to public/onnx/`);
}

console.log(`Copied ${filesToCopy.length} ONNX Runtime files to public/onnx/`);
