/**
 * Unit tests for the title convention the social plugins (Bluesky, LinkedIn,
 * Threads) share. Posts have no title of their own, so this is what shows up
 * in the saved-article list — and all three must agree on it.
 */

import { describe, it, expect } from "vitest";
import {
  MAX_TITLE_LENGTH,
  MIN_ELIDED_TITLE_LENGTH,
  socialPostTitle,
} from "@/server/plugins/social-post";

describe("socialPostTitle", () => {
  it("uses the first line of the text", () => {
    expect(socialPostTitle("First line\nsecond line", "Sen")).toBe("First line");
  });

  it("trims surrounding whitespace", () => {
    expect(socialPostTitle("  padded  \nmore", "Sen")).toBe("padded");
  });

  // The cap and floor are asserted only here — the per-plugin tests check that
  // they route through this helper, not what the numbers are.
  it("keeps a line of exactly the maximum length intact, and elides past it", () => {
    expect(socialPostTitle("x".repeat(MAX_TITLE_LENGTH), "Sen")).toBe("x".repeat(MAX_TITLE_LENGTH));
    expect(socialPostTitle("x".repeat(MAX_TITLE_LENGTH + 1), "Sen")).toBe(
      `${"x".repeat(MAX_TITLE_LENGTH - 1)}…`
    );
  });

  it("elides by code point so it never splits a surrogate pair", () => {
    // Astral-plane code points: a UTF-16 slice would cut an emoji in half.
    const title = socialPostTitle("😀".repeat(MAX_TITLE_LENGTH * 2), "Sen");
    expect([...title]).toHaveLength(MAX_TITLE_LENGTH);
    expect(title.endsWith("😀…")).toBe(true);
  });

  it("drops a trailing partial word rather than cutting mid-word", () => {
    // The cut lands inside the second word.
    const first = "a".repeat(MAX_TITLE_LENGTH - 5);
    expect(socialPostTitle(`${first} ${"b".repeat(10)}`, "Sen")).toBe(`${first}…`);
  });

  it("keeps a whole word the cut happens to end on", () => {
    // The dropped character is a space, so nothing is mid-word — backing up
    // here would discard the complete second word for no reason.
    const kept = `${"a".repeat(10)} ${"b".repeat(MAX_TITLE_LENGTH - 12)}`;
    expect([...kept]).toHaveLength(MAX_TITLE_LENGTH - 1);
    expect(socialPostTitle(`${kept} and more`, "Sen")).toBe(`${kept}…`);
  });

  it("never leaves a space before the ellipsis", () => {
    // The break lands exactly on a space, which would read as "bbb …".
    const kept = `${"a".repeat(10)} ${"b".repeat(MAX_TITLE_LENGTH - 13)}`;
    const title = socialPostTitle(`${kept} cccc dddd`, "Sen");
    expect(title).toBe(`${kept}…`);
    expect(title).not.toContain(" …");
  });

  it("cuts mid-word rather than collapse the title when the opening word is huge", () => {
    // A first "word" longer than the cap (e.g. a bare URL) has no usable boundary.
    const url = `https://example.com/${"a".repeat(MAX_TITLE_LENGTH * 3)}`;
    const title = socialPostTitle(`${url} then text`, "Sen");
    expect([...title]).toHaveLength(MAX_TITLE_LENGTH);
    expect(title.endsWith("…")).toBe(true);
  });

  // The case above has NO space inside the cap, so the backup is a no-op and the
  // floor is never the reason for the result. These have a boundary to back up
  // over, and the floor decides whether to.
  it("backs up to a word boundary that leaves exactly the floor", () => {
    const first = "a".repeat(MIN_ELIDED_TITLE_LENGTH);
    expect(socialPostTitle(`${first} ${"b".repeat(MAX_TITLE_LENGTH)}`, "Sen")).toBe(`${first}…`);
  });

  it("cuts mid-word when backing up would leave less than the floor", () => {
    const first = "a".repeat(MIN_ELIDED_TITLE_LENGTH - 1);
    const title = socialPostTitle(`${first} ${"b".repeat(MAX_TITLE_LENGTH)}`, "Sen");
    // Backing up to the boundary would leave one character under the floor, so
    // the mid-word cut is kept and the title stays full length.
    expect([...title]).toHaveLength(MAX_TITLE_LENGTH);
    expect(title.startsWith(`${first} b`)).toBe(true);
  });

  it("measures the floor in code points, not UTF-16 units", () => {
    // Just under the floor in emoji is twice that in UTF-16 units. Counting
    // units would clear the floor and collapse the title to the emoji.
    const emoji = "😀".repeat(MIN_ELIDED_TITLE_LENGTH - 1);
    expect(emoji.length).toBeGreaterThanOrEqual(MIN_ELIDED_TITLE_LENGTH);
    const title = socialPostTitle(`${emoji} ${"b".repeat(MAX_TITLE_LENGTH)}`, "Sen");
    expect([...title]).toHaveLength(MAX_TITLE_LENGTH);
    expect(title).toContain("b");
  });

  it("collapses whitespace runs so they can't eat the title", () => {
    // A long run of spaces inside the cap would otherwise leave just "a…".
    expect(socialPostTitle(`a${" ".repeat(MAX_TITLE_LENGTH + 10)}b`, "Sen")).toBe("a b");
    // Tabs and hard-wrapped lines collapse the same way.
    expect(socialPostTitle("one\t\ttwo   three", "Sen")).toBe("one two three");
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
