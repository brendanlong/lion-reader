/**
 * Unit tests for `getNarrationPhase`: which controls each narration status offers.
 */

import { describe, it, expect } from "vitest";
import {
  DEFAULT_NARRATION_STATE,
  getNarrationPhase,
} from "../../src/components/narration/useNarrationTypes";
import type { NarrationStatus } from "../../src/lib/narration/types";

/** Mid-article, so both skips are in bounds whenever skipping is offered. */
const MID_ARTICLE = {
  ...DEFAULT_NARRATION_STATE,
  currentParagraph: 7,
  currentNarrationParagraph: 3,
  totalParagraphs: 10,
};

describe("getNarrationPhase", () => {
  const cases: Array<{
    status: NarrationStatus;
    isActive: boolean;
    isGenerating: boolean;
    isBuffering: boolean;
    shouldPause: boolean;
  }> = [
    {
      status: "idle",
      isActive: false,
      isGenerating: false,
      isBuffering: false,
      shouldPause: false,
    },
    {
      status: "generating",
      isActive: false,
      isGenerating: true,
      isBuffering: false,
      shouldPause: false,
    },
    {
      status: "buffering",
      isActive: true,
      isGenerating: false,
      isBuffering: true,
      shouldPause: true,
    },
    {
      status: "playing",
      isActive: true,
      isGenerating: false,
      isBuffering: false,
      shouldPause: true,
    },
    {
      status: "paused",
      isActive: true,
      isGenerating: false,
      isBuffering: false,
      shouldPause: false,
    },
  ];

  it.each(cases)("$status", ({ status, isActive, isGenerating, isBuffering, shouldPause }) => {
    const phase = getNarrationPhase({ ...MID_ARTICLE, status });
    expect(phase).toEqual({
      isPlaying: status === "playing",
      isPaused: status === "paused",
      isBuffering,
      isGenerating,
      isActive,
      shouldPause,
      canSkipBackward: isActive,
      canSkipForward: isActive,
    });
  });

  it("bounds skips by the narration paragraph, not the DOM element", () => {
    const first = getNarrationPhase({
      ...MID_ARTICLE,
      status: "playing",
      currentParagraph: 4,
      currentNarrationParagraph: 0,
    });
    expect(first.canSkipBackward).toBe(false);
    expect(first.canSkipForward).toBe(true);

    const last = getNarrationPhase({
      ...MID_ARTICLE,
      status: "playing",
      currentParagraph: 2,
      currentNarrationParagraph: 9,
    });
    expect(last.canSkipBackward).toBe(true);
    expect(last.canSkipForward).toBe(false);
  });
});
