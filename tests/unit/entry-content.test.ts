/**
 * Unit tests for the entry content-variant selector (src/lib/entry-content.ts).
 */

import { describe, it, expect } from "vitest";
import { selectDisplayedContent, showsFullContent } from "@/lib/entry-content";

const fields = {
  fullContentCleaned: "<p>full cleaned</p>",
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

describe("showsFullContent", () => {
  const fetched = {
    fetchFullContent: true,
    fullContentCleaned: "<p>full cleaned</p>",
    fullContentFetchedAt: new Date("2026-01-01T00:00:00Z"),
    fullContentError: null,
  };

  it("shows a successful fetch", () => {
    expect(showsFullContent(fetched)).toBe(true);
  });

  it("doesn't show a fetch without an article", () => {
    expect(showsFullContent({ ...fetched, fullContentCleaned: null })).toBe(false);
  });
});
