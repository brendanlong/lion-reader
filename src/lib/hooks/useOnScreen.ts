"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";

function subscribeToVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Whether `ref`'s element is in view, within the scroll container, in a tab
 * that's in the foreground. Always false while not `enabled`.
 */
export function useOnScreen(ref: RefObject<Element | null>, enabled: boolean): boolean {
  const scrollContainerRef = useScrollContainer();
  const [intersecting, setIntersecting] = useState(false);
  useEffect(() => {
    const target = ref.current;
    if (!enabled || !target) return;
    const observer = new IntersectionObserver(([entry]) => setIntersecting(entry.isIntersecting), {
      root: scrollContainerRef?.current ?? null,
    });
    observer.observe(target);
    return () => {
      observer.disconnect();
      setIntersecting(false);
    };
  }, [ref, enabled, scrollContainerRef]);
  const pageVisible = useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === "visible",
    () => false
  );
  return enabled && intersecting && pageVisible;
}
