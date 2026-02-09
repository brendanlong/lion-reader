/**
 * EntryListFallback Component
 *
 * Smart Suspense fallback for entry lists. Tries to show cached entries
 * from the TanStack DB entries collection (populated by SuspendingEntryList)
 * while the actual query loads. Falls back to skeleton if no data available.
 *
 * Uses collection.state directly (non-reactive snapshot) rather than useLiveQuery
 * to avoid SSR issues — useLiveQuery uses useSyncExternalStore without
 * getServerSnapshot, which throws during hydration. Since this is a Suspense
 * fallback that renders briefly, a non-reactive read is sufficient.
 */

"use client";

import { useMemo } from "react";
import { useCollections } from "@/lib/collections/context";
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
  /** Currently selected entry ID */
  selectedEntryId?: string | null;
  /** Callback when entry is clicked (disabled during fallback) */
  onEntryClick?: (entryId: string) => void;
}

/**
 * Suspense fallback that shows cached entries when available.
 *
 * Uses the entries collection (populated by SuspendingEntryList) to find
 * entries matching the requested filters. For tag/uncategorized filtering,
 * uses the subscriptions collection to look up subscription-tag relationships.
 *
 * If no cached data matches, renders a skeleton.
 */
export function EntryListFallback({
  filters,
  skeletonCount = 5,
  selectedEntryId,
  onEntryClick,
}: EntryListFallbackProps) {
  const { entries: entriesCollection, subscriptions: subscriptionsCollection } = useCollections();

  // Read non-reactive snapshots from collections — avoids useLiveQuery's
  // useSyncExternalStore which crashes during SSR/hydration
  const allEntries = Array.from(entriesCollection.state.values());
  const allSubscriptions = Array.from(subscriptionsCollection.state.values());

  // Filter entries to match the requested view
  const filteredEntries = useMemo(() => {
    let result = allEntries;

    // Filter by subscription
    if (filters.subscriptionId) {
      result = result.filter((e) => e.subscriptionId === filters.subscriptionId);
    }

    // Filter by tag — find subscriptions in the tag, then filter entries
    if (filters.tagId) {
      const subscriptionIdsInTag = new Set(
        allSubscriptions
          .filter((sub) => sub.tags.some((tag) => tag.id === filters.tagId))
          .map((sub) => sub.id)
      );
      result = result.filter((e) => e.subscriptionId && subscriptionIdsInTag.has(e.subscriptionId));
    }

    // Filter by uncategorized — find subscriptions with no tags
    if (filters.uncategorized) {
      const uncategorizedSubscriptionIds = new Set(
        allSubscriptions.filter((sub) => sub.tags.length === 0).map((sub) => sub.id)
      );
      result = result.filter(
        (e) => e.subscriptionId && uncategorizedSubscriptionIds.has(e.subscriptionId)
      );
    }

    // Filter by starred
    if (filters.starredOnly) {
      result = result.filter((e) => e.starred);
    }

    // Filter by unread
    if (filters.unreadOnly) {
      result = result.filter((e) => !e.read);
    }

    // Filter by type
    if (filters.type) {
      result = result.filter((e) => e.type === filters.type);
    }

    // Sort by ID (UUIDv7 is time-ordered)
    const ascending = filters.sortOrder === "oldest";
    result.sort((a, b) => (ascending ? a.id.localeCompare(b.id) : b.id.localeCompare(a.id)));

    return result;
  }, [allEntries, allSubscriptions, filters]);

  // No cached data - show skeleton
  if (filteredEntries.length === 0) {
    return <EntryListSkeleton count={skeletonCount} />;
  }

  // Show cached entries with a subtle loading indicator
  return (
    <div className="space-y-3">
      {filteredEntries.map((entry) => (
        <EntryListItem
          key={entry.id}
          entry={entry}
          onClick={onEntryClick}
          selected={selectedEntryId === entry.id}
          // Disable mutations during fallback - they'd update stale data
          onToggleRead={undefined}
          onToggleStar={undefined}
        />
      ))}

      {/* Show loading indicator at the bottom */}
      <EntryListLoadingMore label="Loading entries..." />
    </div>
  );
}
