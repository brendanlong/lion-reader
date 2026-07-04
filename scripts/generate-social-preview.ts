/**
 * Generate the social/OG preview image (public/social-preview.png) by
 * screenshotting scripts/social-preview.html at exactly 1200x630.
 *
 * The HTML is a stylized wireframe of the Lion Reader UI with the logo
 * overlaid (see that file). Rendering it with a real browser gives a
 * pixel-perfect, reproducible, easy-to-edit image instead of a hand-made
 * or AI-generated raster.
 *
 * Usage: pnpm social-preview
 */
import { chromium } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

// Standard Open Graph / Twitter card dimensions (1.91:1).
const WIDTH = 1200;
const HEIGHT = 630;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(scriptDir, "social-preview.html");
const outputPath = path.join(scriptDir, "..", "public", "social-preview.png");

async function main() {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: WIDTH, height: HEIGHT },
      deviceScaleFactor: 1,
    });
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
    await page.screenshot({
      path: outputPath,
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT },
    });
    console.log(`Wrote ${outputPath} (${WIDTH}x${HEIGHT})`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
