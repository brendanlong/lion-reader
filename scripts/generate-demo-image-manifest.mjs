/**
 * Generate the demo-image content-hash manifest.
 *
 * The demo hero/OG images in `public/demo/` are served through the Bunny pull
 * zone (see `demoImageUrl` in src/app/(public)/demo/demo-assets.ts). They are
 * NOT content-hashed in their filename (unlike `/_next/static`), so a `?v=<hash>`
 * query string is what lets us serve them `immutable`-style while still busting
 * the CDN + browser cache the moment an image's bytes change. Bunny must be
 * configured to include the `v` query param in its cache key.
 *
 * This writes a deterministic map of `/demo/<file>` -> short content hash that
 * the helper imports on both the server (prerender) and the client (the demo
 * re-renders content after hydration, so the URL must be identical on both).
 *
 * Regenerate whenever a demo image changes: `pnpm generate:demo-images`
 * (also run automatically by `pnpm build`). Commit the result.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// `--check` verifies the committed manifest is up to date (for CI/lint-staged)
// instead of writing it, exiting non-zero on drift.
const checkOnly = process.argv.includes("--check");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const demoDir = join(root, "public", "demo");
const outFile = join(root, "src", "app", "(public)", "demo", "demo-image-manifest.ts");

const files = readdirSync(demoDir).filter((name) => /\.(png|jpg|jpeg|webp|gif|svg)$/i.test(name));
files.sort();

const entries = files.map((name) => {
  const bytes = readFileSync(join(demoDir, name));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  return [`/demo/${name}`, hash];
});

const body = entries.map(([path, hash]) => `  "${path}": "${hash}",`).join("\n");

const contents = `// GENERATED FILE — do not edit by hand.
// Run \`pnpm generate:demo-images\` to regenerate (also run by \`pnpm build\`).
// Maps each public/demo image to a short hash of its bytes, used as a \`?v=\`
// cache-buster when the image is served from the CDN. See demo-assets.ts.

export const DEMO_IMAGE_HASHES: Record<string, string> = {
${body}
};
`;

if (checkOnly) {
  let current = "";
  try {
    current = readFileSync(outFile, "utf8");
  } catch {
    // Missing file counts as out of date.
  }
  if (current !== contents) {
    console.error(
      "demo-image-manifest.ts is out of date. Run `pnpm generate:demo-images` and commit the result."
    );
    process.exit(1);
  }
  console.log(`demo-image-manifest.ts is up to date (${entries.length} images).`);
} else {
  writeFileSync(outFile, contents);
  console.log(`Wrote ${entries.length} demo image hashes to ${outFile}`);
}
