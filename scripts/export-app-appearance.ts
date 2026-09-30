/**
 * Writes the reader appearance tokens (per-font size adjustment and line
 * height, text sizes) the native app shares with the web, so the two readers
 * size text identically. Regenerate with `pnpm app:appearance`; a unit test
 * fails when the committed copy is stale.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BASE_SIZES, FONT_CONFIGS } from "../src/lib/appearance/config";

export const APP_APPEARANCE_PATH = "kmp/androidApp/src/main/assets/reader/appearance.json";

export function renderAppAppearance(): string {
  const fonts = Object.fromEntries(
    Object.entries(FONT_CONFIGS).map(([name, config]) => [
      name,
      { sizeAdjust: config.sizeAdjust, lineHeight: config.lineHeight },
    ])
  );
  return `${JSON.stringify({ fonts, textSizes: BASE_SIZES }, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(APP_APPEARANCE_PATH, renderAppAppearance());
  console.log(`Wrote ${APP_APPEARANCE_PATH}`);
}
