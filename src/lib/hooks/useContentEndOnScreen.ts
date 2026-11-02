"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";

function subscribeToVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Whether `endRef`'s marker, just after `contentRef`'s content, is in view
 * within the scroll container, in a tab that's in the foreground, with no image
 * in view still loading: one that loads can push the end back off screen.
 * Images above the view can't (the browser anchors scrolling to what's in
 * view), so they aren't waited for. Always false while not `enabled`; `content`
 * is what's rendered, so a new article is measured afresh.
 */
export function useContentEndOnScreen(
  contentRef: RefObject<HTMLElement | null>,
  endRef: RefObject<HTMLElement | null>,
  content: string | null,
  enabled: boolean
): boolean {
  const scrollContainerRef = useScrollContainer();
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const end = endRef.current;
    const body = contentRef.current;
    if (!enabled || !end) return;
    const root = scrollContainerRef?.current ?? null;
    // Measured rather than taken from the observer's entry: an image's load
    // event comes before the observer hears of the layout it changes.
    const check = () => {
      const view = root ? root.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
      const inView = (box: DOMRect) => box.bottom >= view.top && box.top <= view.bottom;
      const loading = Array.from(body?.querySelectorAll("img") ?? []).some(
        (img) => !img.complete && inView(img.getBoundingClientRect())
      );
      setOnScreen(inView(end.getBoundingClientRect()) && !loading);
    };
    const observer = new IntersectionObserver(check, { root });
    observer.observe(end);
    // `load` and `error` don't bubble, but they can be captured.
    body?.addEventListener("load", check, true);
    body?.addEventListener("error", check, true);
    return () => {
      observer.disconnect();
      body?.removeEventListener("load", check, true);
      body?.removeEventListener("error", check, true);
      setOnScreen(false);
    };
  }, [contentRef, endRef, content, enabled, scrollContainerRef]);
  const pageVisible = useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === "visible",
    () => false
  );
  return enabled && onScreen && pageVisible;
}
