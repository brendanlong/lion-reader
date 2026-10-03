/**
 * useSidebarFeedNavigation Hook
 *
 * Moves to the next/previous tag or subscription in the sidebar (Shift+J /
 * Shift+K), in the order the sidebar shows them.
 */

"use client";

import { useCallback, useRef } from "react";
import { clientPush } from "@/lib/navigation";
import { isDialogOpen } from "@/components/ui/dialog";

/** Marks the sidebar list whose links Shift+J/Shift+K step through. */
export const SIDEBAR_FEEDS_ATTRIBUTE = "data-sidebar-feeds";

interface VisitedLink {
  link: HTMLAnchorElement;
  href: string;
  index: number;
}

const isActive = (link: HTMLAnchorElement) => link.getAttribute("aria-current") === "page";

/**
 * Returns a function that navigates to the sidebar link after (1) or before
 * (-1) the active one, or the first/last link when no tag or subscription is
 * active.
 *
 * It walks the rendered links rather than the tag/subscription data so it
 * matches exactly what the reader sees: collapsed tags are skipped over, the
 * sidebar's unread-only filter applies, and per-tag pages not yet loaded
 * aren't reachable.
 */
export function useSidebarFeedNavigation(): (direction: 1 | -1) => void {
  const lastVisitedRef = useRef<VisitedLink | null>(null);

  return useCallback((direction: 1 | -1) => {
    if (isDialogOpen()) return;
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(`[${SIDEBAR_FEEDS_ATTRIBUTE}] a[href]`)
    );
    const last = lastVisitedRef.current;
    const stillOnLast = last !== null && window.location.pathname === last.href;

    let target: HTMLAnchorElement | undefined;
    if (stillOnLast && links.includes(last.link) && isActive(last.link)) {
      // A subscription with several tags is listed under each of them, so all
      // its copies are active; continue from the copy we moved to.
      target = links[links.indexOf(last.link) + direction];
    } else if (stillOnLast && !last.link.isConnected && !links.some(isActive)) {
      // The feed we moved to left the sidebar (marked read under the
      // unread-only filter): continue from where it was, not from the top.
      target = links[direction === 1 ? last.index : last.index - 1];
    } else {
      const activeIndex = links.findIndex(isActive);
      target =
        activeIndex === -1
          ? links[direction === 1 ? 0 : links.length - 1]
          : links[activeIndex + direction];
    }
    if (!target) return;

    // Push rather than `target.click()`: a synthetic click carries the
    // held Shift, which ClientLink leaves to the browser (new window).
    const href = target.getAttribute("href")!;
    lastVisitedRef.current = { link: target, href, index: links.indexOf(target) };
    clientPush(href);
    target.scrollIntoView({ block: "nearest" });
  }, []);
}
