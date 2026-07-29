/**
 * Unit tests for the title convention the social plugins (Bluesky, LinkedIn,
 * Threads) share. Posts have no title of their own, so this is what shows up
 * in the saved-article list — and all three must agree on it.
 */

import { describe, it, expect } from "vitest";
import { socialPostTitle } from "@/server/plugins/social-post";

describe("socialPostTitle", () => {
  it("uses the first line of the text", () => {
    expect(socialPostTitle("First line\nsecond line", "Sen")).toBe("First line");
  });

  it("trims surrounding whitespace", () => {
    expect(socialPostTitle("  padded  \nmore", "Sen")).toBe("padded");
  });

  // The cap is asserted numerically only here — the per-plugin tests check that
  // they route through this helper, not what the number is.
  it("keeps a line of exactly the maximum length intact, and elides past it", () => {
    expect(socialPostTitle("x".repeat(60), "Sen")).toBe("x".repeat(60));
    expect(socialPostTitle("x".repeat(61), "Sen")).toBe(`${"x".repeat(59)}…`);
  });

  it("elides by code point so it never splits a surrogate pair", () => {
    // 150 astral-plane code points: a UTF-16 slice would cut an emoji in half.
    const title = socialPostTitle("😀".repeat(150), "Sen");
    expect([...title]).toHaveLength(60);
    expect(title.endsWith("😀…")).toBe(true);
  });

  it("drops a trailing partial word rather than cutting mid-word", () => {
    // The cut lands inside "showing".
    const text = "Opened up your Barnes & Noble NOOK just to find it's showing the wrong time?";
    expect(socialPostTitle(text, "Sen")).toBe(
      "Opened up your Barnes & Noble NOOK just to find it's…"
    );
  });

  it("keeps a whole word the cut happens to end on", () => {
    // The dropped character is a space, so nothing is mid-word — backing up
    // here would discard the complete word "and" for no reason.
    const text = "Some people are complaining that they are seeing videos and photos on Threads";
    expect(socialPostTitle(text, "Sen")).toBe(
      "Some people are complaining that they are seeing videos and…"
    );
  });

  it("never leaves a space before the ellipsis", () => {
    // The break lands exactly on a space, which would read as "Bob …".
    const text = "Just outside of Orlando, Florida is the cemetery where Bob Ross is buried";
    const title = socialPostTitle(text, "Sen");
    expect(title).toBe("Just outside of Orlando, Florida is the cemetery where Bob…");
    expect(title).not.toContain(" …");
  });

  it("cuts mid-word rather than collapse the title when the opening word is huge", () => {
    // A 200-character first "word" (e.g. a bare URL) has no usable boundary.
    const title = socialPostTitle(`https://example.com/${"a".repeat(200)} then text`, "Sen");
    expect([...title]).toHaveLength(60);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to the author when there is no text", () => {
    expect(socialPostTitle("", "Sen")).toBe("Post by Sen");
    expect(socialPostTitle(null, "Sen")).toBe("Post by Sen");
    expect(socialPostTitle(undefined, "Sen")).toBe("Post by Sen");
  });

  it("falls back to a bare 'Post' when there is no author either", () => {
    expect(socialPostTitle("", null)).toBe("Post");
    expect(socialPostTitle("   \n  ", null)).toBe("Post");
  });
});
