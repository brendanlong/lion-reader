/**
 * EntryListSkeleton Component
 *
 * A loading skeleton that mimics the shape of entry list items.
 * Used during initial loading and pagination.
 */

"use client";

import { memo } from "react";
import type { ListDensity } from "@/lib/appearance/settings";

interface EntryListItemSkeletonProps {
  /**
   * Whether to show a longer summary line.
   * Varies to create more natural looking skeletons.
   */
  hasLongSummary?: boolean;

  /**
   * List density (matches EntryListItem so the skeleton doesn't reflow when the
   * real list renders).
   */
  density?: ListDensity;
}

/**
 * Single skeleton item that matches EntryListItem layout.
 */
const EntryListItemSkeleton = memo(function EntryListItemSkeleton({
  hasLongSummary = true,
  density = "comfortable",
}: EntryListItemSkeletonProps) {
  const compact = density === "compact";
  // Compact rows are borderless (the list supplies `divide-edge` separators);
  // comfortable items are bordered cards.
  const containerClasses = compact
    ? "px-3 py-2.5 sm:px-4"
    : "border-edge bg-surface rounded-lg border p-4";

  return (
    <div className={containerClasses}>
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
          {!compact && (
            <div className="mt-2 space-y-1.5">
              <div className="bg-fill-muted h-4 w-full animate-pulse rounded" />
              <div
                className={`bg-fill-muted h-4 animate-pulse rounded ${
                  hasLongSummary ? "w-4/5" : "w-1/2"
                }`}
              />
            </div>
          )}
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

  /**
   * List density (matches the entry list so the skeleton doesn't reflow when the
   * real list renders).
   * @default "comfortable"
   */
  density?: ListDensity;
}

/**
 * EntryListSkeleton component.
 * Renders multiple skeleton items for loading state.
 */
export const EntryListSkeleton = memo(function EntryListSkeleton({
  count = 5,
  density = "comfortable",
}: EntryListSkeletonProps) {
  const listClassName = density === "compact" ? "divide-edge divide-y" : "space-y-3";

  return (
    <div className={listClassName} role="status" aria-label="Loading entries">
      {Array.from({ length: count }, (_, i) => (
        <EntryListItemSkeleton key={i} hasLongSummary={i % 2 === 0} density={density} />
      ))}
      <span className="sr-only">Loading entries...</span>
    </div>
  );
});
