/**
 * EntryListSkeleton Component
 *
 * A loading skeleton that mimics the shape of entry list items.
 * Used during initial loading and pagination.
 */

"use client";

import { memo } from "react";

interface EntryListItemSkeletonProps {
  /**
   * Whether to show a longer summary line.
   * Varies to create more natural looking skeletons.
   */
  hasLongSummary?: boolean;
}

/**
 * Single skeleton item that matches EntryListItem layout.
 */
const EntryListItemSkeleton = memo(function EntryListItemSkeleton({
  hasLongSummary = true,
}: EntryListItemSkeletonProps) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-start gap-3">
        {/* Read indicator skeleton */}
        <div className="mt-1.5 shrink-0">
          <div className="h-2.5 w-2.5 animate-pulse rounded-full bg-zinc-200 dark:bg-zinc-700" />
        </div>

        <div className="min-w-0 flex-1">
          {/* Title skeleton */}
          <div className="flex items-start justify-between gap-2">
            <div className="h-5 w-3/4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          </div>

          {/* Meta row skeleton (feed name and date) */}
          <div className="mt-1 flex items-center gap-2">
            <div className="h-3 w-24 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            <div className="h-3 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          </div>

          {/* Summary skeleton */}
          <div className="mt-2 space-y-1.5">
            <div className="h-4 w-full animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            <div
              className={`h-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700 ${
                hasLongSummary ? "w-4/5" : "w-1/2"
              }`}
            />
          </div>
        </div>
      </div>
    </div>
  );
});

interface EntryListSkeletonProps {
  /**
   * Number of skeleton items to render.
   * @default 5
   */
  count?: number;
}

/**
 * EntryListSkeleton component.
 * Renders multiple skeleton items for loading state.
 */
export const EntryListSkeleton = memo(function EntryListSkeleton({
  count = 5,
}: EntryListSkeletonProps) {
  return (
    <div className="space-y-3" role="status" aria-label="Loading entries">
      {Array.from({ length: count }, (_, i) => (
        <EntryListItemSkeleton key={i} hasLongSummary={i % 2 === 0} />
      ))}
      <span className="sr-only">Loading entries...</span>
    </div>
  );
});
