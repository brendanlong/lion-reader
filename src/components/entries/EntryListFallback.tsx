/**
 * EntryListFallback Component
 *
 * Smart Suspense fallback for entry lists. Tries to show cached entries
 * from parent lists (e.g., "All" list when viewing a subscription) while
 * the actual query loads. Falls back to skeleton if no cached data available.
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { findParentListPlaceholderData } from "@/lib/cache/entry-cache";
import { useAppearance } from "@/lib/appearance/AppearanceProvider";
import { EntryListItem } from "./EntryListItem";
import { EntryListSkeleton } from "./EntryListSkeleton";
import { EntryListLoadingMore } from "./EntryListStates";

/**
 * Filter options for finding placeholder data.
 */
interface EntryListFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
  type?: "web" | "email" | "saved";
}

interface EntryListFallbackProps {
  /** Filters for finding matching cached data */
  filters: EntryListFilters;
  /** Number of skeleton items if no placeholder data */
  skeletonCount?: number;
  /** Callback when entry is clicked (disabled during fallback) */
  onEntryClick?: (entryId: string) => void;
}

/**
 * Suspense fallback that shows cached entries when available.
 *
 * Hierarchy for finding placeholder data:
 * 1. For subscription pages: try the subscription's tag list first
 * 2. Fall back to "All" list (no filters)
 *
 * If no cached data matches, renders a skeleton.
 */
export function EntryListFallback({
  filters,
  skeletonCount = 5,
  onEntryClick,
}: EntryListFallbackProps) {
  const queryClient = useQueryClient();
  const {
    settings: { listDensity },
  } = useAppearance();

  // Try to find placeholder data from cached parent lists
  // Subscriptions are automatically looked up from cache for tag/uncategorized filtering
  const placeholderData = findParentListPlaceholderData(queryClient, filters);

  // No cached data - show skeleton
  if (!placeholderData || placeholderData.pages[0]?.items.length === 0) {
    return <EntryListSkeleton count={skeletonCount} density={listDensity} />;
  }

  // Show cached entries with a subtle loading indicator
  const entries = placeholderData.pages.flatMap((page) => page.items);
  const listClassName = listDensity === "compact" ? "divide-edge divide-y" : "space-y-3";

  return (
    <div>
      <div className={listClassName}>
        {entries.map((entry) => (
          <EntryListItem
            key={entry.id}
            entry={entry}
            onClick={onEntryClick}
            // No selection here: the fallback is a brief pre-load state that
            // isn't wired to keyboard focus (no onFocus), and selection is shown
            // via the focused row's outline — so a `selected` prop would only
            // ever set an aria-label with no matching focus. Selection appears
            // once the real EntryList renders.
            // Disable mutations during fallback - they'd update stale data
            onToggleRead={undefined}
            onToggleStar={undefined}
            density={listDensity}
          />
        ))}
      </div>

      {/* Show loading indicator at the bottom */}
      <EntryListLoadingMore label="Loading entries..." />
    </div>
  );
}
