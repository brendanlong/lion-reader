/**
 * useEntryListScrollResetOnNavigate Hook
 *
 * Resets the entry-list scroll container to the top when the user navigates to
 * a different list. In-app navigation is shallow (`pushState` + AppRouter
 * re-deriving from `usePathname()`), so the browser never resets scroll the way
 * a full navigation would; the scroll container keeps its offset across the list
 * swap and a fresh list would otherwise open scrolled to wherever the previous
 * one was.
 *
 * Keyed on the pathname, exactly like `useEntryListRefreshOnNavigate`: the
 * pathname is the "list identity". The open entry lives in the `?entry=` search
 * param (useEntryUrlState), so opening/closing an entry — or moving between a
 * list and an entry in it — never changes the pathname and never resets scroll
 * (the list stays put under the reader, so closing an entry lands back where you
 * were; the reader itself scrolls its own nested container). Only a genuine list
 * change (sidebar link, All ↔ Starred, subscription/tag swap) resets.
 *
 * Runs in a layout effect so the reset happens before paint (no visible jump).
 *
 * Must be mounted in a component that stays mounted across all client-side
 * navigation (AppRouter) so it observes every list change, and within the
 * ScrollContainerProvider so `useScrollContainer` resolves the `<main>` element.
 *
 * If/when per-article reading-position restore (#406) lands, that restores the
 * *reader's* scroll; this resets the *list's* scroll — separate containers,
 * separate behaviors.
 */

"use client";

import { useLayoutEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";

export function useEntryListScrollResetOnNavigate(): void {
  const pathname = usePathname();
  const scrollContainerRef = useScrollContainer();
  const prevPathnameRef = useRef(pathname);

  useLayoutEffect(() => {
    if (prevPathnameRef.current === pathname) return;
    prevPathnameRef.current = pathname;
    const scrollContainer = scrollContainerRef?.current;
    // scrollTo (a method call) rather than assigning `.scrollTop`, which the
    // react-hooks/immutability lint rule flags as mutating a hook value.
    scrollContainer?.scrollTo({ top: 0 });
  }, [pathname, scrollContainerRef]);
}
