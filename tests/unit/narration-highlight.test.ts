/**
 * Unit tests for which paragraph narration highlights.
 */

import { describe, it, expect } from "vitest";
import { computeHighlightedParagraphs } from "../../src/components/narration/useNarrationHighlight";
import {
  DEFAULT_NARRATION_STATE,
  getNarrationPhase,
} from "../../src/components/narration/useNarrationTypes";

describe("computeHighlightedParagraphs", () => {
  it("highlights the paragraph being narrated", () => {
    expect(computeHighlightedParagraphs(0, true)).toEqual(new Set([0]));
    expect(computeHighlightedParagraphs(7, true)).toEqual(new Set([7]));
  });

  it("highlights nothing while narration is off, or without a position", () => {
    expect(computeHighlightedParagraphs(3, false).size).toBe(0);
    expect(computeHighlightedParagraphs(-1, true).size).toBe(0);
  });

  it("keeps the highlight while paused or buffering, as narration is still on", () => {
    const at = { ...DEFAULT_NARRATION_STATE, currentParagraph: 4, totalParagraphs: 10 };
    for (const status of ["playing", "paused", "loading"] as const) {
      const { isActive } = getNarrationPhase({ ...at, status }, false);
      expect(computeHighlightedParagraphs(at.currentParagraph, isActive)).toEqual(new Set([4]));
    }
    const { isActive } = getNarrationPhase({ ...at, status: "idle" }, false);
    expect(computeHighlightedParagraphs(at.currentParagraph, isActive).size).toBe(0);
  });
});
