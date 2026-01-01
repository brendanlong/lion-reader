/**
 * useSwipeGestures Hook
 *
 * Provides touch swipe gesture navigation for entry views.
 * Similar to the j/k keyboard navigation, but for touch devices.
 *
 * Features:
 * - Swipe left to go to next entry
 * - Swipe right to go to previous entry
 * - Configurable swipe threshold
 * - Only active when entry is open
 */

"use client";

import { useCallback, useRef, RefObject } from "react";

/**
 * Configuration options for swipe gestures.
 */
export interface UseSwipeGesturesOptions {
  /**
   * Array of entry IDs in the current list (in display order).
   */
  entryIds: string[];

  /**
   * The currently open entry ID.
   */
  currentEntryId: string | null;

  /**
   * Callback when navigating to an entry.
   */
  onNavigateToEntry?: (entryId: string) => void;

  /**
   * Whether swipe gestures are enabled.
   * @default true
   */
  enabled?: boolean;

  /**
   * Minimum horizontal distance (in pixels) for a swipe to be recognized.
   * @default 50
   */
  swipeThreshold?: number;

  /**
   * Maximum vertical distance (in pixels) allowed for a horizontal swipe.
   * If exceeded, the gesture is treated as a scroll, not a swipe.
   * @default 100
   */
  maxVerticalDistance?: number;
}

/**
 * Result returned by the useSwipeGestures hook.
 */
export interface UseSwipeGesturesResult {
  /**
   * Touch event handlers to attach to the swipeable element.
   */
  handlers: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchEnd: (e: React.TouchEvent) => void;
  };

  /**
   * Ref to attach to the swipeable container element.
   * This is used to check if the user is at scroll boundaries.
   */
  containerRef: RefObject<HTMLDivElement | null>;

  /**
   * Navigate to the next entry.
   */
  goToNext: () => void;

  /**
   * Navigate to the previous entry.
   */
  goToPrevious: () => void;
}

/**
 * Hook for swipe gesture navigation in entry views.
 *
 * @example
 * ```tsx
 * function EntryView({ entryId, entries, onNavigate }) {
 *   const { handlers, containerRef } = useSwipeGestures({
 *     entryIds: entries.map(e => e.id),
 *     currentEntryId: entryId,
 *     onNavigateToEntry: onNavigate,
 *     enabled: true,
 *   });
 *
 *   return (
 *     <div ref={containerRef} {...handlers}>
 *       <ArticleContent />
 *     </div>
 *   );
 * }
 * ```
 */
export function useSwipeGestures(options: UseSwipeGesturesOptions): UseSwipeGesturesResult {
  const {
    entryIds,
    currentEntryId,
    onNavigateToEntry,
    enabled = true,
    swipeThreshold = 50,
    maxVerticalDistance = 100,
  } = options;

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Get the current index of the open entry
  const getCurrentIndex = useCallback((): number => {
    if (!currentEntryId) return -1;
    return entryIds.indexOf(currentEntryId);
  }, [currentEntryId, entryIds]);

  // Navigate to the next entry
  const goToNext = useCallback(() => {
    if (!onNavigateToEntry || entryIds.length === 0) return;

    const currentIndex = getCurrentIndex();

    if (currentIndex === -1) {
      // Nothing selected, go to first
      onNavigateToEntry(entryIds[0]);
    } else if (currentIndex < entryIds.length - 1) {
      // Go to next
      onNavigateToEntry(entryIds[currentIndex + 1]);
    }
    // If at the last entry, do nothing
  }, [entryIds, getCurrentIndex, onNavigateToEntry]);

  // Navigate to the previous entry
  const goToPrevious = useCallback(() => {
    if (!onNavigateToEntry || entryIds.length === 0) return;

    const currentIndex = getCurrentIndex();

    if (currentIndex === -1) {
      // Nothing selected, go to last
      onNavigateToEntry(entryIds[entryIds.length - 1]);
    } else if (currentIndex > 0) {
      // Go to previous
      onNavigateToEntry(entryIds[currentIndex - 1]);
    }
    // If at the first entry, do nothing
  }, [entryIds, getCurrentIndex, onNavigateToEntry]);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || !currentEntryId) return;

      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    },
    [enabled, currentEntryId]
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || !currentEntryId || !touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;

      // Reset touch start
      touchStartRef.current = null;

      // Check if vertical movement is too large (user is scrolling, not swiping)
      if (Math.abs(deltaY) > maxVerticalDistance) {
        return;
      }

      // Check if horizontal movement meets threshold
      if (Math.abs(deltaX) < swipeThreshold) {
        return;
      }

      // Determine swipe direction
      if (deltaX < 0) {
        // Swipe left -> next entry
        goToNext();
      } else {
        // Swipe right -> previous entry
        goToPrevious();
      }
    },
    [enabled, currentEntryId, swipeThreshold, maxVerticalDistance, goToNext, goToPrevious]
  );

  return {
    handlers: {
      onTouchStart,
      onTouchEnd,
    },
    containerRef,
    goToNext,
    goToPrevious,
  };
}
