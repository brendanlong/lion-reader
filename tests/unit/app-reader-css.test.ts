import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { APP_READER_CSS_PATH, renderAppReaderCss } from "../../scripts/export-app-reader-css";

describe("native app reader stylesheet", () => {
  it("is the web's reader-prose.css (run `pnpm app:reader-css`)", () => {
    expect(readFileSync(APP_READER_CSS_PATH, "utf8")).toBe(renderAppReaderCss());
  });
});
