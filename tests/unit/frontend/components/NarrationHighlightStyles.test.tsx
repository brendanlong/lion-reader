/**
 * @vitest-environment jsdom
 */

/**
 * The narration highlight takes its colors from the theme, so each theme
 * (including e-paper, which needs grays from its ramp) sets them in one place.
 */

import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { NarrationHighlightStyles } from "@/components/narration/NarrationHighlightStyles";

const GLOBALS_CSS = readFileSync("src/app/globals.css", "utf8");

/** The declarations of the first rule block opened by `selector` in globals.css. */
function themeBlock(selector: string): string {
  const start = GLOBALS_CSS.indexOf(`${selector} {`);
  expect(start, `${selector} in globals.css`).toBeGreaterThanOrEqual(0);
  return GLOBALS_CSS.slice(start, GLOBALS_CSS.indexOf("}", start));
}

describe("NarrationHighlightStyles", () => {
  it("colors the highlight only with tokens every theme defines", () => {
    const { container } = render(
      <NarrationHighlightStyles highlightedParagraphIds={new Set([0, 2])} enabled />
    );
    const css = container.querySelector("style")?.innerHTML ?? "";

    expect(css).toContain('[data-para-id="para-2"]');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    const tokens = [...css.matchAll(/var\((--[\w-]+)\)/g)].map((match) => match[1]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const theme of [
      ":root",
      ".dark",
      ".epaper",
      ":root:not(.dark):not(.light):not(.epaper)",
    ]) {
      const block = themeBlock(theme);
      for (const token of tokens) expect(block, `${token} in ${theme}`).toContain(`${token}:`);
    }
  });

  it("marks e-paper's highlight with a ring, not a fill", () => {
    // E-paper carries state on borders (src/components/CLAUDE.md).
    const epaper = themeBlock(".epaper");
    expect(epaper).toContain("--narration-highlight: transparent;");
    expect(epaper).not.toMatch(/--narration-highlight-edge: 0;/);
  });
});
