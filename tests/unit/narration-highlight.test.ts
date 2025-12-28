/**
 * Unit tests for narration paragraph highlighting.
 *
 * Tests the pure logic of determining which paragraphs should be highlighted
 * during narration playback based on the paragraph mapping from the backend.
 */

import { describe, it, expect } from "vitest";
import {
  computeHighlightedParagraphs,
  type ParagraphMapEntry,
} from "../../src/components/narration/useNarrationHighlight";

describe("computeHighlightedParagraphs", () => {
  describe("when not playing", () => {
    it("returns empty set when isPlaying is false", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 0, false);

      expect(result.size).toBe(0);
    });

    it("returns empty set when paused with valid map and index", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0, 1] },
        { n: 1, o: [2] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 0, false);

      expect(result.size).toBe(0);
    });
  });

  describe("basic single mapping", () => {
    it("returns single paragraph ID for simple 1:1 mapping", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
        { n: 2, o: [2] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 1, true);

      expect(result).toEqual(new Set([1]));
    });

    it("returns correct ID for first paragraph", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 0, true);

      expect(result).toEqual(new Set([0]));
    });

    it("returns correct ID for last paragraph", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
        { n: 2, o: [2] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 2, true);

      expect(result).toEqual(new Set([2]));
    });

    it("handles non-sequential original indices", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [2] }, // Skipped index 1
        { n: 2, o: [5] }, // Skipped indices 3, 4
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 1, true);

      expect(result).toEqual(new Set([2]));
    });
  });

  describe("multiple original indices (combined paragraphs)", () => {
    it("returns multiple IDs when LLM combined two paragraphs", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1, 2] }, // Combined paragraphs 1 and 2
        { n: 2, o: [3] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 1, true);

      expect(result).toEqual(new Set([1, 2]));
    });

    it("returns multiple IDs when LLM combined three paragraphs", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0, 1, 2] }, // Combined paragraphs 0, 1, and 2
        { n: 1, o: [3] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 0, true);

      expect(result).toEqual(new Set([0, 1, 2]));
    });

    it("handles non-consecutive combined indices", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0, 2, 4] }, // Every other paragraph combined
        { n: 1, o: [1, 3, 5] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 0, true);

      expect(result).toEqual(new Set([0, 2, 4]));
    });
  });

  describe("missing mapping fallback", () => {
    it("falls back to same index when mapping not found", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        // Missing mapping for n: 1
        { n: 2, o: [2] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 1, true);

      // Falls back to highlighting index 1
      expect(result).toEqual(new Set([1]));
    });

    it("falls back when index exceeds map entries", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
      ];

      const result = computeHighlightedParagraphs(paragraphMap, 5, true);

      expect(result).toEqual(new Set([5]));
    });
  });

  describe("edge cases", () => {
    it("returns empty set for negative index", () => {
      const paragraphMap: ParagraphMapEntry[] = [{ n: 0, o: [0] }];

      const result = computeHighlightedParagraphs(paragraphMap, -1, true);

      expect(result.size).toBe(0);
    });

    it("falls back to same index when paragraphMap is null", () => {
      const result = computeHighlightedParagraphs(null, 2, true);

      expect(result).toEqual(new Set([2]));
    });

    it("falls back to same index when paragraphMap is empty array", () => {
      const result = computeHighlightedParagraphs([], 3, true);

      expect(result).toEqual(new Set([3]));
    });

    it("returns empty set when negative index with null map", () => {
      const result = computeHighlightedParagraphs(null, -1, true);

      expect(result.size).toBe(0);
    });

    it("handles index 0 correctly", () => {
      const paragraphMap: ParagraphMapEntry[] = [{ n: 0, o: [0] }];

      const result = computeHighlightedParagraphs(paragraphMap, 0, true);

      expect(result).toEqual(new Set([0]));
    });

    it("handles large indices", () => {
      const paragraphMap: ParagraphMapEntry[] = [{ n: 999, o: [1000, 1001] }];

      const result = computeHighlightedParagraphs(paragraphMap, 999, true);

      expect(result).toEqual(new Set([1000, 1001]));
    });

    it("handles single paragraph map", () => {
      const paragraphMap: ParagraphMapEntry[] = [{ n: 0, o: [0] }];

      const result = computeHighlightedParagraphs(paragraphMap, 0, true);

      expect(result).toEqual(new Set([0]));
    });

    it("handles empty original indices array gracefully", () => {
      const paragraphMap: ParagraphMapEntry[] = [{ n: 0, o: [] }];

      const result = computeHighlightedParagraphs(paragraphMap, 0, true);

      // Returns empty set from the empty array
      expect(result.size).toBe(0);
    });
  });

  describe("state transitions", () => {
    it("produces different results as index changes", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
        { n: 2, o: [2] },
      ];

      expect(computeHighlightedParagraphs(paragraphMap, 0, true)).toEqual(new Set([0]));
      expect(computeHighlightedParagraphs(paragraphMap, 1, true)).toEqual(new Set([1]));
      expect(computeHighlightedParagraphs(paragraphMap, 2, true)).toEqual(new Set([2]));
    });

    it("clears highlighting when playback stops", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
      ];

      // Playing - should highlight
      expect(computeHighlightedParagraphs(paragraphMap, 1, true)).toEqual(new Set([1]));

      // Not playing - should not highlight
      expect(computeHighlightedParagraphs(paragraphMap, 1, false).size).toBe(0);
    });

    it("restores highlighting when playback resumes", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1, 2] },
      ];

      // Not playing - no highlight
      expect(computeHighlightedParagraphs(paragraphMap, 1, false).size).toBe(0);

      // Playing - should highlight
      expect(computeHighlightedParagraphs(paragraphMap, 1, true)).toEqual(new Set([1, 2]));
    });
  });

  describe("realistic scenarios", () => {
    it("handles typical article with LLM combining short paragraphs", () => {
      // Simulates an article where the LLM combined some short intro paragraphs
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] }, // Heading
        { n: 1, o: [1, 2, 3] }, // LLM combined intro paragraphs
        { n: 2, o: [4] }, // Code block
        { n: 3, o: [5] }, // Explanation
        { n: 4, o: [6, 7] }, // LLM combined conclusion
      ];

      // Heading
      expect(computeHighlightedParagraphs(paragraphMap, 0, true)).toEqual(new Set([0]));

      // Combined intro
      expect(computeHighlightedParagraphs(paragraphMap, 1, true)).toEqual(new Set([1, 2, 3]));

      // Code block
      expect(computeHighlightedParagraphs(paragraphMap, 2, true)).toEqual(new Set([4]));

      // Explanation
      expect(computeHighlightedParagraphs(paragraphMap, 3, true)).toEqual(new Set([5]));

      // Combined conclusion
      expect(computeHighlightedParagraphs(paragraphMap, 4, true)).toEqual(new Set([6, 7]));
    });

    it("handles fallback TTS without paragraph map", () => {
      // When using htmlToPlainText fallback, there may be no map
      // Should fall back to highlighting same index
      expect(computeHighlightedParagraphs(null, 0, true)).toEqual(new Set([0]));
      expect(computeHighlightedParagraphs(null, 3, true)).toEqual(new Set([3]));
    });

    it("handles article with skipped content", () => {
      // LLM might skip some elements (like complex tables)
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] }, // Intro
        { n: 1, o: [1] }, // Text before table
        // Table at index 2 is skipped by LLM
        { n: 2, o: [3] }, // Text after table
      ];

      expect(computeHighlightedParagraphs(paragraphMap, 0, true)).toEqual(new Set([0]));
      expect(computeHighlightedParagraphs(paragraphMap, 1, true)).toEqual(new Set([1]));
      expect(computeHighlightedParagraphs(paragraphMap, 2, true)).toEqual(new Set([3]));
    });

    it("handles sequential playback through article", () => {
      const paragraphMap: ParagraphMapEntry[] = [
        { n: 0, o: [0] },
        { n: 1, o: [1] },
        { n: 2, o: [2, 3] },
        { n: 3, o: [4] },
      ];

      // Simulate playing through the article
      const playSequence = [0, 1, 2, 3];
      const expectedHighlights = [new Set([0]), new Set([1]), new Set([2, 3]), new Set([4])];

      playSequence.forEach((index, i) => {
        expect(computeHighlightedParagraphs(paragraphMap, index, true)).toEqual(
          expectedHighlights[i]
        );
      });
    });
  });
});
