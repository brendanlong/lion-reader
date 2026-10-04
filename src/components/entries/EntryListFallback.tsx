/**
 * EntryListFallback Component
 *
 * Smart loading fallback for entry lists: while a view's first page loads,
 * shows the entries the local store already holds that match the view's
 * filters (e.g. a subscription's entries seen in "All"). Falls back to a
 * skeleton when there are none.
 */

"use client";

import { useLocalEntriesMatching } from "@/lib/hooks/useLocalEntries";
import { useLocalSubscriptions } from "@/lib/hooks/useLocalSubscriptions";
import { UNCATEGORIZED_SECTION, isInSidebarSection } from "@/lib/sidebar-sections";
import type { EntryListFilters } from "@/lib/local-db/entry-lists";
import { useAppearance } from "@/lib/appearance/AppearanceProvider";
import { EntryListItem } from "./EntryListItem";
import { EntryListSkeleton } from "./EntryListSkeleton";
import { EntryListLoadingMore } from "./EntryListStates";

interface EntryListFallbackProps {
  /** The loading view's filters */
  filters: EntryListFilters;
  /** Callback when entry is clicked (disabled during fallback) */
  onEntryClick?: (entryId: string) => void;
}

/**
 * Tag and uncategorized views depend on subscription tags: narrow them to the
 * stored subscriptions that qualify, or `null` (skeleton) when none are
 * stored, rather than showing unfiltered entries.
 */
function useSubscriptionScope(filters: EntryListFilters): string[] | undefined | null {
  const stored = useLocalSubscriptions();
  const section = filters.tagId ?? (filters.uncategorized ? UNCATEGORIZED_SECTION : undefined);
  if (section === undefined) return undefined;
  if (stored.length === 0) return null;
  return stored.filter((row) => isInSidebarSection(row, section)).map((row) => row.id);
}

export function EntryListFallback({ filters, onEntryClick }: EntryListFallbackProps) {
  const {
    settings: { listDensity },
  } = useAppearance();
  const entries = useLocalEntriesMatching(filters, useSubscriptionScope(filters));

  if (!entries || entries.length === 0) {
    return <EntryListSkeleton density={listDensity} />;
  }

  // Show stored entries with a subtle loading indicator
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
