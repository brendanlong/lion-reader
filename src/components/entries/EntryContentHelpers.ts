/**
 * Entry Content Helpers
 *
 * Shared helper functions for entry content components.
 */

/**
 * Format a date as a readable string.
 */
export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Swipe gesture configuration constants.
 */
const SWIPE_CONFIG = {
  /** Minimum horizontal distance for swipe */
  SWIPE_THRESHOLD: 50,
  /** Maximum ratio of vertical to horizontal movement (0.5 = require 2:1 horizontal-to-vertical) */
  MAX_VERTICAL_RATIO: 0.5,
} as const;

/**
 * Detect swipe direction from touch start/end coordinates.
 * Returns "left", "right", or null if the gesture doesn't qualify as a swipe.
 */
export function detectSwipeDirection(
  start: { x: number; y: number },
  end: { x: number; y: number }
): "left" | "right" | null {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;

  if (Math.abs(deltaY) > Math.abs(deltaX) * SWIPE_CONFIG.MAX_VERTICAL_RATIO) {
    return null;
  }
  if (Math.abs(deltaX) < SWIPE_CONFIG.SWIPE_THRESHOLD) {
    return null;
  }
  return deltaX < 0 ? "left" : "right";
}
