/**
 * Entry Content Helpers
 *
 * Shared helper functions for entry content components.
 */

/**
 * Format a date as a readable string.
 *
 * @param timeZone Optional IANA time zone (e.g. "America/Los_Angeles"). When
 *   omitted the runtime's ambient zone is used (the visitor's local zone in the
 *   browser). Pass an explicit zone to get a deterministic result independent of
 *   where the code runs — e.g. so a server render doesn't default to the host's
 *   UTC and then differ from the client's local render.
 */
export function formatDate(date: Date, timeZone?: string): string {
  return date.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone ? { timeZone } : {}),
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
 * Width (CSS px) of the strip along each screen edge reserved for the
 * OS/browser back-forward navigation gesture (iOS edge swipe, Android gesture
 * nav). Covers the system zones on both platforms: ~20pt on iOS, 24-32dp on
 * Android.
 */
const EDGE_GESTURE_ZONE_PX = 32;

/**
 * Convert a touch's layout-viewport clientX into its physical distance (screen
 * CSS px) from the left edge of the screen.
 *
 * The OS back-forward gesture zone is a fixed *physical* strip, but touch
 * clientX is in *layout* px: when pinch-zoomed it's offset by the pan and one
 * layout px spans `scale` screen px, so a layout-px edge zone would grow with
 * zoom (40% of the screen per side at 5x). Falls back to clientX when the
 * visualViewport API is unavailable (scale 1, no pan — the two are identical).
 */
export function getScreenX(clientX: number): number {
  const vv = typeof window !== "undefined" ? window.visualViewport : null;
  if (!vv) return clientX;
  return (clientX - vv.offsetLeft) * vv.scale;
}

/**
 * Whether a swipe is (likely) the OS/browser back-forward navigation gesture:
 * a rightward swipe starting against the left screen edge, or a leftward swipe
 * starting against the right edge. Some browsers (notably installed PWAs)
 * deliver the full touch sequence for these gestures *and* perform history
 * navigation, so also treating them as an article swipe navigates twice —
 * opening (and auto-marking read) the adjacent article before the browser's
 * history-back lands on the list (#1260).
 *
 * Both coordinates are physical screen CSS px: `startScreenX` from
 * getScreenX(), `screenWidth` from window.innerWidth (the layout viewport
 * width, which pinch-zoom doesn't change). Returns false when the width is
 * unknown (<= 0) so navigation is never blocked outright.
 */
export function isEdgeGestureSwipe(
  direction: "left" | "right",
  startScreenX: number,
  screenWidth: number
): boolean {
  if (screenWidth <= 0) return false;
  return direction === "right"
    ? startScreenX <= EDGE_GESTURE_ZONE_PX
    : startScreenX >= screenWidth - EDGE_GESTURE_ZONE_PX;
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
