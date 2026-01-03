/**
 * Unit tests for narration paragraph highlighting.
 *
 * Tests the pure logic of determining which paragraphs should be highlighted
 * during narration playback. With 1:1 mapping, this is straightforward:
 * narration paragraph N always highlights original paragraph N.
 */

import { describe, it, expect } from "vitest";
import { computeHighlightedParagraphs } from "../../src/components/narration/useNarrationHighlight";

describe("computeHighlightedParagraphs", () => {
  describe("when not playing", () => {
    it("returns empty set when isPlaying is false", () => {
      const result = computeHighlightedParagraphs(0, false);
      expect(result.size).toBe(0);
    });

    it("returns empty set when paused at any index", () => {
      expect(computeHighlightedParagraphs(0, false).size).toBe(0);
      expect(computeHighlightedParagraphs(5, false).size).toBe(0);
      expect(computeHighlightedParagraphs(100, false).size).toBe(0);
    });
  });

  describe("when playing", () => {
    it("returns set with current index for paragraph 0", () => {
      const result = computeHighlightedParagraphs(0, true);
      expect(result).toEqual(new Set([0]));
    });

    it("returns set with current index for paragraph 1", () => {
      const result = computeHighlightedParagraphs(1, true);
      expect(result).toEqual(new Set([1]));
    });

    it("returns set with current index for paragraph 5", () => {
      const result = computeHighlightedParagraphs(5, true);
      expect(result).toEqual(new Set([5]));
    });

    it("handles large indices", () => {
      const result = computeHighlightedParagraphs(999, true);
      expect(result).toEqual(new Set([999]));
    });
  });

  describe("edge cases", () => {
    it("returns empty set for negative index", () => {
      const result = computeHighlightedParagraphs(-1, true);
      expect(result.size).toBe(0);
    });

    it("returns empty set for negative index when not playing", () => {
      const result = computeHighlightedParagraphs(-1, false);
      expect(result.size).toBe(0);
    });
  });

  describe("state transitions", () => {
    it("produces different results as index changes", () => {
      expect(computeHighlightedParagraphs(0, true)).toEqual(new Set([0]));
      expect(computeHighlightedParagraphs(1, true)).toEqual(new Set([1]));
      expect(computeHighlightedParagraphs(2, true)).toEqual(new Set([2]));
    });

    it("clears highlighting when playback stops", () => {
      // Playing - should highlight
      expect(computeHighlightedParagraphs(1, true)).toEqual(new Set([1]));

      // Not playing - should not highlight
      expect(computeHighlightedParagraphs(1, false).size).toBe(0);
    });

    it("restores highlighting when playback resumes", () => {
      // Not playing - no highlight
      expect(computeHighlightedParagraphs(1, false).size).toBe(0);

      // Playing - should highlight
      expect(computeHighlightedParagraphs(1, true)).toEqual(new Set([1]));
    });
  });

  describe("realistic scenarios", () => {
    it("handles sequential playback through article", () => {
      // Simulate playing through paragraphs 0-4
      const playSequence = [0, 1, 2, 3, 4];

      playSequence.forEach((index) => {
        expect(computeHighlightedParagraphs(index, true)).toEqual(new Set([index]));
      });
    });

    it("handles skipping to a later paragraph", () => {
      // User skips from paragraph 0 to paragraph 10
      expect(computeHighlightedParagraphs(0, true)).toEqual(new Set([0]));
      expect(computeHighlightedParagraphs(10, true)).toEqual(new Set([10]));
    });
  });
});
