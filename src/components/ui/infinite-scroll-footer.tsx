/**
 * Infinite scroll for a paginated list: `useLoadMoreSentinel` fetches the next
 * page when its sentinel element nears the view, and `InfiniteScrollFooter` is
 * that sentinel plus a spinner while loading and `endLabel` once every page is
 * loaded. Render the footer only after a non-empty list.
 */

"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useScrollContainer } from "@/components/layout/ScrollContainerContext";
import { SpinnerIcon } from "./icons";

interface PaginationState {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}

/**
 * A ref for the sentinel element: once it comes within 100px of the enclosing
 * scroll container (`ScrollContainerContext`, else the viewport), the next
 * page is fetched.
 */
export function useLoadMoreSentinel<T extends Element>({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
}: PaginationState): RefObject<T | null> {
  const sentinelRef = useRef<T>(null);
  const scrollContainerRef = useScrollContainer();

  useEffect(() => {
    const target = sentinelRef.current;
    if (!target || !hasNextPage || isFetchingNextPage) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) fetchNextPage();
      },
      { root: scrollContainerRef?.current ?? null, rootMargin: "100px", threshold: 0 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, scrollContainerRef]);

  return sentinelRef;
}

interface InfiniteScrollFooterProps extends PaginationState {
  endLabel: string;
}

export function InfiniteScrollFooter({ endLabel, ...pagination }: InfiniteScrollFooterProps) {
  const sentinelRef = useLoadMoreSentinel<HTMLDivElement>(pagination);
  const { hasNextPage, isFetchingNextPage } = pagination;

  return (
    <>
      <div ref={sentinelRef} className="h-1" />
      {isFetchingNextPage && (
        <div className="flex items-center justify-center p-4">
          <SpinnerIcon className="text-faint mr-2 h-4 w-4" />
          <span className="ui-text-sm text-muted">Loading more...</span>
        </div>
      )}
      {!hasNextPage && <p className="ui-text-xs text-faint p-3 text-center">{endLabel}</p>}
    </>
  );
}
