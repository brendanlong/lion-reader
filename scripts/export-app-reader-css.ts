/**
 * Copies the reader's content stylesheet (`src/app/reader-prose.css`) into the
 * native app's assets, so both readers render feed markup the same way.
 * Regenerate with `pnpm app:reader-css`; a unit test fails when the committed
 * copy is stale.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const APP_READER_CSS_PATH = "kmp/androidApp/src/main/assets/reader/reader-prose.css";

export function renderAppReaderCss(): string {
  return `/* Generated from src/app/reader-prose.css by \`pnpm app:reader-css\`; do not edit. */\n${readFileSync("src/app/reader-prose.css", "utf8")}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(APP_READER_CSS_PATH, renderAppReaderCss());
  console.log(`Wrote ${APP_READER_CSS_PATH}`);
}
