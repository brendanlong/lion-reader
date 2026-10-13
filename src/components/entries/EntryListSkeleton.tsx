/**
 * EntryListSkeleton Component
 *
 * A loading skeleton that mimics the shape of entry list items.
 * Used during initial loading and pagination.
 */

"use client";

import { memo } from "react";
import { ENTRY_LIST_CLASSES } from "./entryItemClasses";

interface EntryListItemSkeletonProps {
  /**
   * Whether to show a longer summary line.
   * Varies to create more natural looking skeletons.
   */
  hasLongSummary: boolean;
}

/**
 * Single skeleton item that matches EntryListItem layout.
 */
const EntryListItemSkeleton = memo(function EntryListItemSkeleton({
  hasLongSummary,
}: EntryListItemSkeletonProps) {
  // Compact rows are borderless (the list supplies `divide-edge` separators);
  // comfortable items are bordered cards. Matches EntryListItem, so the
  // skeleton doesn't reflow when the real list renders.
  return (
    <div className="comfortable:border-edge comfortable:bg-surface comfortable:rounded-lg comfortable:border comfortable:p-4 compact:px-3 compact:py-2.5 compact:sm:px-4">
      <div className="flex items-start gap-3">
        {/* Read indicator skeleton */}
        <div className="mt-1.5 shrink-0">
          <div className="bg-fill-muted h-2.5 w-2.5 animate-pulse rounded-full" />
        </div>

        <div className="min-w-0 flex-1">
          {/* Title skeleton */}
          <div className="flex items-start justify-between gap-2">
            <div className="bg-fill-muted h-5 w-3/4 animate-pulse rounded" />
          </div>

          {/* Meta row skeleton (feed name and date) */}
          <div className="mt-1 flex items-center gap-2">
            <div className="bg-fill-muted h-3 w-24 animate-pulse rounded" />
            <div className="bg-fill-muted h-3 w-16 animate-pulse rounded" />
          </div>

          {/* Summary skeleton (hidden in compact density, matching EntryListItem) */}
          <div className="compact:hidden mt-2 space-y-1.5">
            <div className="bg-fill-muted h-4 w-full animate-pulse rounded" />
            <div
              className={`bg-fill-muted h-4 animate-pulse rounded ${
                hasLongSummary ? "w-4/5" : "w-1/2"
              }`}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * EntryListSkeleton component.
 * Renders multiple skeleton items for loading state.
 */
export const EntryListSkeleton = memo(function EntryListSkeleton() {
  return (
    <div className={ENTRY_LIST_CLASSES} role="status" aria-label="Loading entries">
      {Array.from({ length: 5 }, (_, i) => (
        <EntryListItemSkeleton key={i} hasLongSummary={i % 2 === 0} />
      ))}
      <span className="sr-only">Loading entries...</span>
    </div>
  );
});
