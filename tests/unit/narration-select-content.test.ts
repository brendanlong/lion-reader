/**
 * Unit tests for the narration content-variant selector.
 *
 * This is the single source of truth for "which content is on screen" shared by
 * the renderer and the narration router, so narration reads (and highlights
 * against) exactly the variant the user is viewing.
 */

import { describe, it, expect } from "vitest";
import { selectDisplayedContent } from "../../src/lib/narration/select-content";

const fields = {
  fullContentCleaned: "<p>full cleaned</p>",
  fullContentOriginal: "<p>full original</p>",
  contentCleaned: "<p>cleaned</p>",
  contentOriginal: "<p>original</p>",
};

describe("selectDisplayedContent", () => {
  it("defaults to cleaned feed content", () => {
    expect(selectDisplayedContent(fields, { showFullContent: false, showOriginal: false })).toBe(
      "<p>cleaned</p>"
    );
  });

  it("returns original feed content when showOriginal is set", () => {
    expect(selectDisplayedContent(fields, { showFullContent: false, showOriginal: true })).toBe(
      "<p>original</p>"
    );
  });

  it("returns full content when showFullContent is set (winning over showOriginal)", () => {
    expect(selectDisplayedContent(fields, { showFullContent: true, showOriginal: true })).toBe(
      "<p>full cleaned</p>"
    );
  });

  it("falls back full-cleaned -> full-original", () => {
    expect(
      selectDisplayedContent(
        { ...fields, fullContentCleaned: null },
        { showFullContent: true, showOriginal: false }
      )
    ).toBe("<p>full original</p>");
  });

  it("falls back cleaned -> original when cleaned is missing", () => {
    expect(
      selectDisplayedContent(
        { ...fields, contentCleaned: null },
        { showFullContent: false, showOriginal: false }
      )
    ).toBe("<p>original</p>");
  });

  it("returns null when the requested variant has no content", () => {
    expect(
      selectDisplayedContent(
        { contentCleaned: null, contentOriginal: null },
        { showFullContent: true, showOriginal: false }
      )
    ).toBeNull();
  });
});
