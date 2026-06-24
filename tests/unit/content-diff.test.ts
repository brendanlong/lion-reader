import { describe, it, expect } from "vitest";
import { computeContentDiff, applyContentDiff } from "../../src/lib/content-diff";

/** Round-trip: applying the diff to the base must rebuild the target exactly. */
function expectRoundTrip(base: string, target: string) {
  const diff = computeContentDiff(base, target);
  expect(applyContentDiff(base, diff)).toBe(target);
  return diff;
}

describe("content-diff", () => {
  it("reconstructs the target from base + diff", () => {
    expectRoundTrip(
      "<article>hello</article>",
      "Published on 2024<br/><br/><article>hello</article>"
    );
  });

  it("produces a tiny middle for a prefix-only edit (LessWrong case)", () => {
    const cleaned = "<p>The actual article body that is fairly long.</p>";
    const original = `Published on Jan 1, 2024<br/><br/>${cleaned}`;
    const diff = expectRoundTrip(cleaned, original);

    // Only the stripped prefix is carried in the diff, not the whole body.
    expect(diff.middle).toBe("Published on Jan 1, 2024<br/><br/>");
    expect(diff.middle.length).toBeLessThan(cleaned.length);
  });

  it("handles a suffix-only edit", () => {
    expectRoundTrip("the body", "the body<footer>extra</footer>");
  });

  it("handles an edit in the middle", () => {
    expectRoundTrip("<p>start MID end</p>", "<p>start DIFFERENT MIDDLE end</p>");
  });

  it("handles identical strings", () => {
    const diff = expectRoundTrip("same", "same");
    expect(diff.middle).toBe("");
  });

  it("handles an empty base", () => {
    expectRoundTrip("", "now there is content");
  });

  it("handles an empty target", () => {
    expectRoundTrip("had content", "");
  });

  it("does not let an overlapping prefix/suffix double-count", () => {
    // "aaaa" vs "aa": prefix and suffix both want to match the shared a's, but
    // the suffix must not overlap the prefix.
    expectRoundTrip("aaaa", "aa");
    expectRoundTrip("aa", "aaaa");
  });
});
