/**
 * EntryListSkeleton Component
 *
 * A loading skeleton that mimics the shape of entry list items.
 * Used during initial loading and pagination.
 */

"use client";

import { memo } from "react";
import type { ListDensity } from "@/lib/appearance/settings";
import { useAppearance } from "@/lib/appearance/AppearanceProvider";
import { SkeletonText } from "@/components/ui/skeleton";
import { getItemClasses } from "./entryItemClasses";

interface EntryListItemSkeletonProps {
  /**
   * Whether to show a longer summary line.
   * Varies to create more natural looking skeletons.
   */
  hasLongSummary: boolean;

  density: ListDensity;
}

/**
 * Single skeleton item that matches EntryListItem layout: the same card, with
 * each text line on the font size and color of the line it stands in for.
 */
const EntryListItemSkeleton = memo(function EntryListItemSkeleton({
  hasLongSummary,
  density,
}: EntryListItemSkeletonProps) {
  return (
    <div className={`${getItemClasses(false, density)} pointer-events-none`}>
      <div className="flex items-start gap-3">
        {/* Read indicator */}
        <div className="mt-1.5 shrink-0">
          <span className="border-edge-input block h-2.5 w-2.5 rounded-full border" />
        </div>

        <div className="min-w-0 flex-1">
          <SkeletonText width="w-3/4" className="ui-text-sm text-body" />

          <div className="ui-text-xs text-muted mt-1 flex items-center gap-2">
            <SkeletonText width="w-24" />
            <SkeletonText width="w-12" />
          </div>

          {/* Summary (hidden in compact density, matching EntryListItem) */}
          {density !== "compact" && (
            <div className="ui-text-sm text-muted mt-2">
              <SkeletonText width="w-full" />
              <SkeletonText width={hasLongSummary ? "w-4/5" : "w-1/2"} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

/**
 * EntryListSkeleton component.
 * Renders multiple skeleton items for loading state, in the list density the
 * real list will use so it doesn't reflow when it renders.
 */
export const EntryListSkeleton = memo(function EntryListSkeleton() {
  const {
    settings: { listDensity },
  } = useAppearance();
  const listClassName = listDensity === "compact" ? "divide-edge divide-y" : "space-y-3";

  return (
    <div className={listClassName} role="status" aria-label="Loading entries">
      {Array.from({ length: 5 }, (_, i) => (
        <EntryListItemSkeleton key={i} hasLongSummary={i % 2 === 0} density={listDensity} />
      ))}
      <span className="sr-only">Loading entries...</span>
    </div>
  );
});
