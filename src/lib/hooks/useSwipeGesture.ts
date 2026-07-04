import { useCallback, useRef } from "react";
import { detectSwipeDirection } from "@/components/entries/EntryContentHelpers";

export function useSwipeGesture({
  onSwipeLeft,
  onSwipeRight,
  enabled = true,
}: {
  onSwipeLeft?: () => void;
  onSwipeRight?: () => void;
  enabled?: boolean;
}) {
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled) return;
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    },
    [enabled]
  );

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!enabled || !touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const start = touchStartRef.current;
      touchStartRef.current = null;

      const direction = detectSwipeDirection(start, {
        x: touch.clientX,
        y: touch.clientY,
      });

      if (direction === "left") {
        onSwipeLeft?.();
      } else if (direction === "right") {
        onSwipeRight?.();
      }
    },
    [enabled, onSwipeLeft, onSwipeRight]
  );

  return { onTouchStart, onTouchEnd };
}
