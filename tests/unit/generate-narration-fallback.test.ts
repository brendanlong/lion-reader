/**
 * Unit tests for generateNarration's fallback path (no provider key configured).
 *
 * The fallback converts HTML to plain-text narration and must produce a
 * paragraph map aligned with how the player splits paragraphs — including when a
 * single block element's text contains blank-line breaks (e.g. <br><br>-encoded
 * paragraphs), which is exactly the case that used to desync highlighting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { generateNarration } from "../../src/server/services/narration";
import { splitNarrationParagraphs } from "../../src/lib/narration/paragraph-map";
import { NARRATION_PROVIDERS } from "../../src/lib/narration/constants";
import { AI_PROVIDER_ENV_KEYS } from "../../src/server/services/ai-providers";

describe("generateNarration fallback paragraph map", () => {
  // Force the no-LLM fallback path deterministically by clearing every provider
  // narration can use.
  const narrationKeyVars = NARRATION_PROVIDERS.map((provider) => AI_PROVIDER_ENV_KEYS[provider]);
  const previousKeys = Object.fromEntries(
    narrationKeyVars.map((name) => [name, process.env[name]])
  );

  beforeAll(() => {
    for (const name of narrationKeyVars) delete process.env[name];
  });
  afterAll(() => {
    for (const [name, value] of Object.entries(previousKeys)) {
      if (value !== undefined) process.env[name] = value;
    }
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
});
