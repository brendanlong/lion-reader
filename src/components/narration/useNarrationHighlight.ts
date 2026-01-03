/**
 * useNarrationHighlight Hook
 *
 * Manages highlighting state during narration playback. Returns the paragraph
 * index that should be highlighted based on the current narration position.
 *
 * With the simplified 1:1 paragraph mapping, narration paragraph N always
 * corresponds to original paragraph N.
 *
 * Usage:
 * ```tsx
 * const { highlightedParagraphIds } = useNarrationHighlight({
 *   currentParagraphIndex: state.currentParagraph,
 *   isPlaying: state.status === 'playing',
 * });
 * ```
 */

"use client";

import { useMemo } from "react";

/**
 * Configuration for the useNarrationHighlight hook.
 */
export interface UseNarrationHighlightProps {
  /** Current narration paragraph index (0-based) */
  currentParagraphIndex: number;
  /** Whether narration is currently playing */
  isPlaying: boolean;
}

/**
 * Return type for the useNarrationHighlight hook.
 */
export interface UseNarrationHighlightResult {
  /** Set of original paragraph indices that should be highlighted */
  highlightedParagraphIds: Set<number>;
}

/**
 * Pure function to compute highlighted paragraph IDs.
 *
 * This is the core business logic, extracted for testability.
 * With 1:1 mapping, the highlighted paragraph is simply the current index.
 *
 * @param currentParagraphIndex - Current narration paragraph index
 * @param isPlaying - Whether narration is playing
 * @returns Set of original paragraph indices to highlight
 */
export function computeHighlightedParagraphs(
  currentParagraphIndex: number,
  isPlaying: boolean
): Set<number> {
  // No highlighting when not playing
  if (!isPlaying) {
    return new Set<number>();
  }

  // No highlighting for invalid indices
  if (currentParagraphIndex < 0) {
    return new Set<number>();
  }

  // 1:1 mapping: highlight the current paragraph index
  return new Set([currentParagraphIndex]);
}

/**
 * Hook for managing paragraph highlighting during narration.
 *
 * Returns the set of original paragraph indices that should be highlighted
 * based on the current narration position.
 *
 * Features:
 * - Returns empty set when not playing (no highlighting when paused/stopped)
 * - Uses 1:1 mapping (narration paragraph N = original paragraph N)
 * - Handles edge cases gracefully (negative index)
 *
 * @param props - Configuration including current index and playing state
 * @returns Object with highlightedParagraphIds set
 */
export function useNarrationHighlight({
  currentParagraphIndex,
  isPlaying,
}: UseNarrationHighlightProps): UseNarrationHighlightResult {
  const highlightedParagraphIds = useMemo(
    () => computeHighlightedParagraphs(currentParagraphIndex, isPlaying),
    [currentParagraphIndex, isPlaying]
  );

  return { highlightedParagraphIds };
}
