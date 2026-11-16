/**
 * Unit tests for the plain-text (no LLM) narration fallback.
 *
 * The fallback converts HTML to plain-text narration and must produce a
 * paragraph map aligned with how the player splits paragraphs — including when a
 * single block element's text contains blank-line breaks (e.g. <br><br>-encoded
 * paragraphs), which is exactly the case that used to desync highlighting.
 */

import { describe, it, expect } from "vitest";
import { buildFallbackNarration } from "../../src/server/services/narration";
import { htmlToNarrationInput } from "../../src/lib/narration/html-to-narration-input";
import { splitNarrationParagraphs } from "../../src/lib/narration/paragraph-map";

const fallbackFor = (html: string) => buildFallbackNarration(htmlToNarrationInput(html).paragraphs);

describe("buildFallbackNarration paragraph map", () => {
  it("aligns the map with the split for clean per-<p> content", () => {
    const result = fallbackFor("<p>First.</p><p>Second.</p>");

    expect(result.source).toBe("fallback");
    const segments = splitNarrationParagraphs(result.text);
    expect(segments).toEqual(["First.", "Second."]);
    expect(result.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
    ]);
  });

  it("keeps the map aligned when a block encodes multiple paragraphs with <br><br>", () => {
    // Source newlines around <br><br> put a blank line inside a single block's
    // narration text — the shape that desynced highlighting.
    const html = ["<p>Intro.</p>", "<p>Line one.", "<br /><br />", "Line two.</p>"].join("\n");
    const result = fallbackFor(html);

    const segments = splitNarrationParagraphs(result.text);
    // The second <p> (element index 1) becomes two player paragraphs.
    expect(segments).toEqual(["Intro.", "Line one.", "Line two."]);
    expect(result.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
      { n: 2, o: 1 },
    ]);
  });
});
