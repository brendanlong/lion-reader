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

/**
 * Tolerance (CSS px) for treating the visual viewport as flush against a layout
 * viewport edge; absorbs sub-pixel rounding from pinch-zoom.
 */
const VIEWPORT_EDGE_EPSILON = 1;

export type ViewportEdges = {
  /** Visual viewport is at (or near) the left edge of the layout viewport. */
  atLeftEdge: boolean;
  /** Visual viewport is at (or near) the right edge of the layout viewport. */
  atRightEdge: boolean;
};

/**
 * Capture whether the (possibly pinch-zoomed) visual viewport is panned against
 * the left/right edge of the layout viewport.
 *
 * When the page isn't zoomed the visual viewport fills the layout viewport, so
 * both edges read true. Returns both-true when the visualViewport API is
 * unavailable (SSR, older browsers), degrading to the un-zoomed default so
 * navigation is never blocked.
 */
export function getViewportEdges(): ViewportEdges {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv || typeof document === "undefined") {
    return { atLeftEdge: true, atRightEdge: true };
  }
  const layoutWidth = document.documentElement.clientWidth;
  return {
    atLeftEdge: vv.offsetLeft <= VIEWPORT_EDGE_EPSILON,
    atRightEdge: vv.offsetLeft + vv.width >= layoutWidth - VIEWPORT_EDGE_EPSILON,
  };
}

/**
 * Whether a swipe in the given direction may navigate, given the viewport edge
 * state captured when the gesture began.
 *
 * Swiping left advances to the next article, which only makes sense once the
 * user has panned to the right edge of a zoomed article; swiping right (to the
 * previous article) requires the left edge. When the article isn't zoomed both
 * edges are true, so navigation is always allowed and behavior is unchanged.
 */
export function isSwipeNavigationAllowed(
  direction: "left" | "right",
  edges: ViewportEdges
): boolean {
  return direction === "left" ? edges.atRightEdge : edges.atLeftEdge;
}
