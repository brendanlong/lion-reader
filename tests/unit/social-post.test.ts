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

  it("keeps a line of exactly the maximum length intact, and elides past it", () => {
    expect(socialPostTitle("x".repeat(100), "Sen")).toBe("x".repeat(100));
    expect(socialPostTitle("x".repeat(101), "Sen")).toBe(`${"x".repeat(99)}…`);
  });

  it("elides by code point so it never splits a surrogate pair", () => {
    // 150 astral-plane code points: a UTF-16 slice would cut an emoji in half.
    const title = socialPostTitle("😀".repeat(150), "Sen");
    expect([...title]).toHaveLength(100);
    expect(title.endsWith("😀…")).toBe(true);
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
