/**
 * SidebarSkeleton Component
 *
 * A loading skeleton that mimics the shape of the sidebar.
 * Used during initial loading.
 */

"use client";

import { memo } from "react";

/**
 * SidebarSkeleton component.
 * Renders a skeleton matching the sidebar layout.
 */
export const SidebarSkeleton = memo(function SidebarSkeleton() {
  return (
    <nav
      className="flex h-full flex-col bg-white dark:bg-zinc-900"
      role="status"
      aria-label="Loading sidebar"
    >
      {/* Main Navigation Skeleton */}
      <div className="space-y-1 p-3">
        {/* All Items link skeleton */}
        <div className="flex items-center justify-between rounded-md px-3 py-2">
          <div className="h-4 w-20 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          <div className="h-3 w-6 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        </div>

        {/* Starred link skeleton */}
        <div className="flex items-center rounded-md px-3 py-2">
          <div className="h-4 w-16 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        </div>
      </div>

      {/* Divider */}
      <div className="mx-3 border-t border-zinc-200 dark:border-zinc-700" />

      {/* Feeds Section Skeleton */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* Feeds header */}
        <div className="mb-2 px-3">
          <div className="h-3 w-12 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
        </div>

        {/* Feed items skeleton */}
        <div className="space-y-1">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="flex items-center justify-between rounded-md px-3 py-2">
              <div
                className="h-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700"
                style={{ width: `${50 + (i % 3) * 15}%` }}
              />
              <div className="h-3 w-6 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
            </div>
          ))}
        </div>
      </div>

      <span className="sr-only">Loading sidebar...</span>
    </nav>
  );
});
