/**
 * Sentinel + footer for a paginated list: fetches the next page when the
 * sentinel scrolls into view, shows a spinner while loading, and `endLabel`
 * once every page is loaded.
 */

"use client";

import { useEffect, useRef } from "react";
import { SpinnerIcon } from "./icons";

interface InfiniteScrollFooterProps {
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
  endLabel: string;
}

export function InfiniteScrollFooter({
  hasNextPage,
  isFetchingNextPage,
  fetchNextPage,
  endLabel,
}: InfiniteScrollFooterProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasNextPage && !isFetchingNextPage) {
          fetchNextPage();
        }
      },
      { rootMargin: "100px", threshold: 0 }
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [fetchNextPage, hasNextPage, isFetchingNextPage]);

  return (
    <>
      <div ref={loadMoreRef} className="h-1" />
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
