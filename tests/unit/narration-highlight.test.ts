/**
 * Unit tests for which paragraph narration highlights.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_NARRATION_STATE,
  getHighlightedParagraph,
} from "../../src/components/narration/useNarrationTypes";

describe("getHighlightedParagraph", () => {
  const at = { ...DEFAULT_NARRATION_STATE, currentParagraph: 4, totalParagraphs: 10 };

  it("highlights the paragraph being narrated while paused or buffering too", () => {
    for (const status of ["playing", "paused", "buffering"] as const) {
      expect(getHighlightedParagraph({ ...at, status })).toBe(4);
    }
    expect(getHighlightedParagraph({ ...at, status: "playing", currentParagraph: 0 })).toBe(0);
  });

  it("highlights nothing while narration is off, or without a position", () => {
    for (const status of ["idle", "generating"] as const) {
      expect(getHighlightedParagraph({ ...at, status })).toBeNull();
    }
    expect(getHighlightedParagraph({ ...at, status: "playing", currentParagraph: -1 })).toBeNull();
  });
});
