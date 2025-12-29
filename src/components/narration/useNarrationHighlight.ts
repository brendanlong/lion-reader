/**
 * useNarrationHighlight Hook
 *
 * Manages highlighting state during narration playback. Tracks which original
 * paragraph IDs should be highlighted based on the current narration paragraph
 * index and the paragraph mapping from the backend.
 *
 * Usage:
 * ```tsx
 * const { highlightedParagraphIds } = useNarrationHighlight({
 *   paragraphMap,
 *   currentParagraphIndex: state.currentParagraph,
 *   isPlaying: state.status === 'playing',
 * });
 * ```
 */

"use client";

import { useMemo } from "react";

/**
 * Paragraph mapping entry from the backend.
 * Maps a narration paragraph index to one or more original paragraph indices.
 */
export interface ParagraphMapEntry {
  /** Narration paragraph index */
  n: number;
  /** Original paragraph indices (can be multiple if LLM combined paragraphs) */
  o: number[];
}

/**
 * Configuration for the useNarrationHighlight hook.
 */
export interface UseNarrationHighlightProps {
  /** Mapping from narration paragraphs to original paragraphs (from API) */
  paragraphMap: ParagraphMapEntry[] | null;
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
 *
 * @param paragraphMap - Mapping from narration to original paragraphs
 * @param currentParagraphIndex - Current narration paragraph index
 * @param isPlaying - Whether narration is playing
 * @returns Set of original paragraph indices to highlight
 */
export function computeHighlightedParagraphs(
  paragraphMap: ParagraphMapEntry[] | null,
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

  // No map available - use fallback (same index)
  if (!paragraphMap || paragraphMap.length === 0) {
    return new Set([currentParagraphIndex]);
  }

  // Find mapping for current narration paragraph
  const mapping = paragraphMap.find((m) => m.n === currentParagraphIndex);

  if (!mapping) {
    // Fallback: highlight paragraph at same index
    return new Set([currentParagraphIndex]);
  }

  // Return the set of original paragraph indices
  return new Set(mapping.o);
}

/**
 * Hook for managing paragraph highlighting during narration.
 *
 * Returns the set of original paragraph indices that should be highlighted
 * based on the current narration position and the paragraph mapping.
 *
 * Features:
 * - Returns empty set when not playing (no highlighting when paused/stopped)
 * - Looks up mapping entry for current narration paragraph
 * - Supports multiple original paragraphs (when LLM combined content)
 * - Falls back to same index when no mapping available
 * - Handles edge cases gracefully (negative index, null map)
 *
 * @param props - Configuration including paragraph map, current index, and playing state
 * @returns Object with highlightedParagraphIds set
 */
export function useNarrationHighlight({
  paragraphMap,
  currentParagraphIndex,
  isPlaying,
}: UseNarrationHighlightProps): UseNarrationHighlightResult {
  const highlightedParagraphIds = useMemo(
    () => computeHighlightedParagraphs(paragraphMap, currentParagraphIndex, isPlaying),
    [paragraphMap, currentParagraphIndex, isPlaying]
  );

  return { highlightedParagraphIds };
}
