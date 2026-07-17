/**
 * Unit tests for generateNarration's fallback path (no Groq key configured).
 *
 * The fallback converts HTML to plain-text narration and must produce a
 * paragraph map aligned with how the player splits paragraphs — including when a
 * single block element's text contains blank-line breaks (e.g. <br><br>-encoded
 * paragraphs), which is exactly the case that used to desync highlighting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateNarration } from "../../src/server/services/narration";
import { splitNarrationParagraphs } from "../../src/lib/narration/paragraph-map";

describe("generateNarration fallback paragraph map", () => {
  const prevKey = process.env.GROQ_API_KEY;

  // Force the no-LLM fallback path deterministically.
  beforeAll(() => {
    delete process.env.GROQ_API_KEY;
  });
  afterAll(() => {
    if (prevKey !== undefined) process.env.GROQ_API_KEY = prevKey;
  });

  it("aligns the map with the split for clean per-<p> content", async () => {
    const result = await generateNarration("<p>First.</p><p>Second.</p>");

    expect(result.source).toBe("fallback");
    const segments = splitNarrationParagraphs(result.text);
    expect(segments).toEqual(["First.", "Second."]);
    expect(result.paragraphMap.length).toBe(segments.length);
    expect(result.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
    ]);
  });

  it("keeps the map aligned when a block encodes multiple paragraphs with <br><br>", async () => {
    // Source newlines around <br><br> put a blank line inside a single block's
    // narration text — the shape that desynced highlighting.
    const html = ["<p>Intro.</p>", "<p>Line one.", "<br /><br />", "Line two.</p>"].join("\n");
    const result = await generateNarration(html);

    const segments = splitNarrationParagraphs(result.text);
    // The second <p> (element index 1) becomes two player paragraphs.
    expect(segments).toEqual(["Intro.", "Line one.", "Line two."]);
    expect(result.paragraphMap.length).toBe(segments.length);
    expect(result.paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
      { n: 2, o: 1 },
    ]);
  });

  it("maintains the length invariant for every narration paragraph", async () => {
    const html = [
      "<h1>Title</h1>",
      "<blockquote>Quote part one.",
      "<br /><br />",
      "Quote part two.</blockquote>",
      "<p>Closing.</p>",
    ].join("\n");
    const result = await generateNarration(html);

    const segments = splitNarrationParagraphs(result.text);
    expect(result.paragraphMap.length).toBe(segments.length);
    result.paragraphMap.forEach((entry, i) => expect(entry.n).toBe(i));
  });
});
