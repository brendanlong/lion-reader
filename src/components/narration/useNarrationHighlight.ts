/**
 * useNarrationHighlight Hook
 *
 * Which paragraph to highlight: the DOM element being narrated
 * (`state.currentParagraph`, already translated from the player's narration
 * paragraph through the paragraph map), for as long as narration is on —
 * paused included, so the reader can see where it will pick up, as in the app.
 *
 * Usage:
 * ```tsx
 * const { highlightedParagraphIds } = useNarrationHighlight({
 *   currentParagraphIndex: state.currentParagraph,
 *   isActive: getNarrationPhase(state, isLoading).isActive,
 * });
 * ```
 */

"use client";

import { useMemo } from "react";

export interface UseNarrationHighlightProps {
  /** DOM element index (`para-N`) of the paragraph being narrated. */
  currentParagraphIndex: number;
  /** Whether narration is on: playing, paused or buffering, with a position. */
  isActive: boolean;
}

export interface UseNarrationHighlightResult {
  /** DOM element indices to highlight. */
  highlightedParagraphIds: Set<number>;
}

/** The pure core of {@link useNarrationHighlight}. */
export function computeHighlightedParagraphs(
  currentParagraphIndex: number,
  isActive: boolean
): Set<number> {
  if (!isActive || currentParagraphIndex < 0) return new Set<number>();
  return new Set([currentParagraphIndex]);
}

export function useNarrationHighlight({
  currentParagraphIndex,
  isActive,
}: UseNarrationHighlightProps): UseNarrationHighlightResult {
  const highlightedParagraphIds = useMemo(
    () => computeHighlightedParagraphs(currentParagraphIndex, isActive),
    [currentParagraphIndex, isActive]
  );

  return { highlightedParagraphIds };
}
