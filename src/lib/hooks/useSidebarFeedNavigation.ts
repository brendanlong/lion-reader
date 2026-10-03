/**
 * useSidebarFeedNavigation Hook
 *
 * Moves to the next/previous tag or subscription in the sidebar (Shift+J /
 * Shift+K), in the order the sidebar shows them.
 */

"use client";

import { useCallback, useRef } from "react";

/** Marks the sidebar list whose links Shift+J/Shift+K step through. */
export const SIDEBAR_FEEDS_ATTRIBUTE = "data-sidebar-feeds";

/**
 * Returns a function that clicks the sidebar link after (1) or before (-1) the
 * active one, or the first/last link when no tag or subscription is active.
 *
 * It walks the rendered links rather than the tag/subscription data so it
 * matches exactly what the reader sees: collapsed tags are skipped over, the
 * sidebar's unread-only filter applies, and per-tag pages not yet loaded
 * aren't reachable. Clicking the link reuses its navigation (mobile drawer
 * close, same-page refresh).
 */
export function useSidebarFeedNavigation(): (direction: 1 | -1) => void {
  // A subscription with several tags is listed under each of them, so all its
  // copies are active at once. Remembering which copy we moved to keeps
  // Shift+J moving forward instead of jumping back to the first copy.
  const lastLinkRef = useRef<HTMLAnchorElement | null>(null);

  return useCallback((direction: 1 | -1) => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(`[${SIDEBAR_FEEDS_ATTRIBUTE}] a[href]`)
    );
    if (links.length === 0) return;

    const last = lastLinkRef.current;
    const currentIndex =
      last && last.getAttribute("aria-current") === "page" && links.includes(last)
        ? links.indexOf(last)
        : links.findIndex((link) => link.getAttribute("aria-current") === "page");

    const target =
      currentIndex === -1
        ? links[direction === 1 ? 0 : links.length - 1]
        : links[currentIndex + direction];
    if (!target) return;

    lastLinkRef.current = target;
    target.click();
    target.scrollIntoView({ block: "nearest" });
  }, []);
}
