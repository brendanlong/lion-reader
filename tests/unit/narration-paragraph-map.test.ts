/**
 * Unit tests for the narration paragraph map builder.
 *
 * These pin the invariant that keeps TTS playback in sync with paragraph
 * highlighting: the paragraph map must have exactly one entry per paragraph the
 * player sees (per `\n\n`-delimited segment of the narration text), in order.
 * A block element whose narration text spans multiple blank-line-separated
 * paragraphs must contribute one map entry per paragraph, all pointing back to
 * that element's `data-para-id`.
 */

import { describe, it, expect } from "vitest";
import {
  buildAlignedNarration,
  splitNarrationParagraphs,
  type NarrationElement,
} from "../../src/lib/narration/paragraph-map";

describe("splitNarrationParagraphs", () => {
  it("splits on blank lines, trims, and drops empties", () => {
    expect(splitNarrationParagraphs("a\n\nb")).toEqual(["a", "b"]);
    expect(splitNarrationParagraphs("  a  \n\n\n  b  ")).toEqual(["a", "b"]);
    expect(splitNarrationParagraphs("a\n\n\n\nb")).toEqual(["a", "b"]);
    expect(splitNarrationParagraphs("")).toEqual([]);
    expect(splitNarrationParagraphs("\n\n")).toEqual([]);
  });

  it("does not split on single newlines", () => {
    expect(splitNarrationParagraphs("a\nb")).toEqual(["a\nb"]);
  });
});

describe("buildAlignedNarration", () => {
  it("keeps the map aligned with the player's paragraph split", () => {
    const elements: NarrationElement[] = [
      { o: 0, text: "First" },
      { o: 1, text: "Second" },
    ];
    const { narrationText, paragraphMap } = buildAlignedNarration(elements);

    expect(narrationText).toBe("First\n\nSecond");
    expect(paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 1 },
    ]);
  });

  it("expands a block with internal blank lines into multiple entries sharing its element index", () => {
    // A single block (o=4) whose narration text holds three paragraphs — the
    // exact shape produced by <br><br>-formatted content and by an LLM that
    // reflows a run-on block. All three must map back to o=4.
    const elements: NarrationElement[] = [
      { o: 3, text: "Intro line." },
      { o: 4, text: "Byline\n\nHow many times...\n\nSurvivorship Bias" },
      { o: 5, text: "Next block." },
    ];
    const { narrationText, paragraphMap } = buildAlignedNarration(elements);

    const segments = splitNarrationParagraphs(narrationText);
    expect(segments).toEqual([
      "Intro line.",
      "Byline",
      "How many times...",
      "Survivorship Bias",
      "Next block.",
    ]);
    // One map entry per player paragraph, in order.
    expect(paragraphMap).toEqual([
      { n: 0, o: 3 },
      { n: 1, o: 4 },
      { n: 2, o: 4 },
      { n: 3, o: 4 },
      { n: 4, o: 5 },
    ]);
  });

  it("drops empty elements without consuming a paragraph slot (LLM-blanked / non-narratable blocks)", () => {
    const elements: NarrationElement[] = [
      { o: 0, text: "Kept." },
      { o: 1, text: "" }, // e.g. code block, empty list container, LLM-blanked junk
      { o: 2, text: "   " }, // whitespace-only
      { o: 3, text: "Also kept." },
    ];
    const { narrationText, paragraphMap } = buildAlignedNarration(elements);

    expect(narrationText).toBe("Kept.\n\nAlso kept.");
    expect(paragraphMap).toEqual([
      { n: 0, o: 0 },
      { n: 1, o: 3 },
    ]);
  });

  it("handles empty input", () => {
    const { narrationText, paragraphMap } = buildAlignedNarration([]);
    expect(narrationText).toBe("");
    expect(paragraphMap).toEqual([]);
  });

  it("guarantees length(map) === length(split) and correct back-references for any input", () => {
    // Mixed: empties, single-paragraph blocks, and multi-paragraph blocks.
    const elements: NarrationElement[] = [
      { o: 0, text: "a\n\nb" },
      { o: 1, text: "" },
      { o: 2, text: "c" },
      { o: 3, text: "d\n\n\ne\n\nf" },
      { o: 4, text: "   " },
      { o: 5, text: "g" },
    ];
    const { narrationText, paragraphMap } = buildAlignedNarration(elements);
    const segments = splitNarrationParagraphs(narrationText);

    // The core invariant: the player's split and the map are the same length,
    // index for index, and re-splitting the built text is a fixed point.
    expect(paragraphMap.length).toBe(segments.length);
    paragraphMap.forEach((entry, i) => {
      expect(entry.n).toBe(i);
    });
    // Every segment traces back to the element it came from.
    expect(paragraphMap.map((e) => e.o)).toEqual([0, 0, 2, 3, 3, 3, 5]);
    expect(segments).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
});
