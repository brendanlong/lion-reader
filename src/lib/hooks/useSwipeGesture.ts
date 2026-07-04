import { useCallback, useRef } from "react";
import {
  detectSwipeDirection,
  getViewportEdges,
  isSwipeNavigationAllowed,
  type ViewportEdges,
} from "@/components/entries/EntryContentHelpers";

export function useSwipeGesture({
  onSwipeLeft,
  onSwipeRight,
  enabled = true,
}: {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  enabled?: boolean;
}) {
  const touchStartRef = useRef<{
    x: number;
    y: number;
    edges: ViewportEdges;
  } | null>(null);
  // Set once a gesture ever involves more than one finger (pinch-to-zoom, etc.).
  // Such a gesture is never treated as a navigation swipe, even after fingers
  // lift back down to one.
  const multiTouchRef = useRef(false);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return;
      // A second finger means pinch-zoom or another multi-touch gesture, not a
      // navigation swipe. Abandon any in-progress swipe.
      if (e.touches.length > 1) {
        multiTouchRef.current = true;
        touchStartRef.current = null;
        return;
      }
      multiTouchRef.current = false;
      const touch = e.touches[0];
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        // Capture the pan position at the start of the gesture so a swipe that
        // begins mid-pan of a zoomed article scrolls instead of navigating.
        edges: getViewportEdges(),
      };
    },
    [enabled]
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      // Ignore any gesture that became multi-touch; reset once all fingers lift.
      if (multiTouchRef.current) {
        if (e.touches.length === 0) multiTouchRef.current = false;
        return;
      }
      if (!enabled || !touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const start = touchStartRef.current;
      touchStartRef.current = null;

      const direction = detectSwipeDirection(start, {
        x: touch.clientX,
        y: touch.clientY,
      });
      if (!direction) return;

      // When the article is pinch-zoomed, only navigate if the swipe started
      // against the edge it moves toward; otherwise the user is panning around
      // the zoomed content.
      if (!isSwipeNavigationAllowed(direction, start.edges)) return;

      if (direction === "left") {
        onSwipeLeft?.();
      } else if (direction === "right") {
        onSwipeRight?.();
      }
    },
    [enabled, onSwipeLeft, onSwipeRight]
  );

  // Browsers frequently fire `touchcancel` (not `touchend`) when they hijack a
  // gesture for pinch-zoom/scroll. Abandon any in-progress swipe and clear the
  // multi-touch flag once all fingers lift, so it can't linger stale-true into
  // the next gesture.
  const onTouchCancel = useCallback((e: React.TouchEvent) => {
    touchStartRef.current = null;
    if (e.touches.length === 0) multiTouchRef.current = false;
  }, []);

  return { onTouchStart, onTouchEnd, onTouchCancel };
}
