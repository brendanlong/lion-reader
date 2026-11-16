/**
 * EntryList Component
 *
 * Presentational paginated entry list with infinite scroll. The entries and
 * query state are always supplied by the parent container (which owns the
 * `entries.list` query, its loading fallback, and — via `throwOnError` — its
 * error handling); this component only renders them, wires up the
 * infinite-scroll observer, and shows the empty/end-of-list states.
 */

"use client";

import { useLoadMoreSentinel } from "@/components/ui/infinite-scroll-footer";
import { useAppearance } from "@/lib/appearance/AppearanceProvider";
import { EntryListItem, type EntryListItemData } from "./EntryListItem";
import { EntryListEmpty, EntryListLoadingMore, EntryListEnd } from "./EntryListStates";

/**
 * Query state for the list, supplied by the parent container that owns the
 * `entries.list` query.
 */
export interface ExternalQueryState {
  /**
   * Whether more entries are being fetched.
   */
  isFetchingNextPage: boolean;

  /**
   * Whether there are more entries to load.
   */
  hasNextPage: boolean;

  /**
   * Fetch the next page of entries.
   */
  fetchNextPage: () => void;
}

interface EntryListProps {
  /**
   * Callback when an entry is clicked.
   */
  onEntryClick?: (entryId: string) => void;

  /**
   * Callback when mousedown fires on an entry (used for prefetching).
   */
  onEntryMouseDown?: (entryId: string) => void;

  /**
   * The href that opens an entry, rendered as a real link on the title so the
   * list is crawlable and middle/modifier clicks open a new tab.
   */
  getEntryHref?: (entryId: string) => string;

  /**
   * Custom empty state message.
   */
  emptyMessage?: string;

  /**
   * Currently selected entry ID (for keyboard navigation highlighting).
   */
  selectedEntryId?: string | null;

  /**
   * Callback when an entry row receives focus (Tab), used to sync the
   * keyboard-shortcut selection with browser focus.
   */
  onEntryFocus?: (entryId: string) => void;

  /**
   * Callback when the read status indicator is clicked.
   */
  onToggleRead?: (entryId: string, currentlyRead: boolean) => void;

  /**
   * Callback when the star indicator is clicked.
   */
  onToggleStar?: (entryId: string, currentlyStarred: boolean) => void;

  /**
   * Entries to render (the parent container owns the query).
   */
  externalEntries: EntryListItemData[];

  /**
   * Query state for the entries (the parent container owns the query).
   */
  externalQueryState: ExternalQueryState;
}

/**
 * EntryList component with infinite scroll.
 */
export function EntryList({
  onEntryClick,
  onEntryMouseDown,
  getEntryHref,
  emptyMessage = "No entries to display",
  selectedEntryId,
  onEntryFocus,
  onToggleRead,
  onToggleStar,
  externalEntries: allEntries,
  externalQueryState,
}: EntryListProps) {
  const {
    settings: { listDensity },
  } = useAppearance();

  const { isFetchingNextPage, hasNextPage } = externalQueryState;
  const loadMoreRef = useLoadMoreSentinel<HTMLDivElement>(externalQueryState);

  if (allEntries.length === 0) {
    return <EntryListEmpty message={emptyMessage} />;
  }

  // Compact density: a single divided list (dividers survive e-paper via the
  // darker `--edge`). Comfortable: gapped bordered cards.
  const listClassName = listDensity === "compact" ? "divide-edge divide-y" : "space-y-3";

  return (
    <div>
      <div className={listClassName}>
        {allEntries.map((entry) => (
          <EntryListItem
            key={entry.id}
            entry={entry}
            href={getEntryHref?.(entry.id)}
            onClick={onEntryClick}
            onMouseDown={onEntryMouseDown}
            onFocus={onEntryFocus}
            selected={selectedEntryId === entry.id}
            onToggleRead={onToggleRead}
            onToggleStar={onToggleStar}
            density={listDensity}
          />
        ))}
      </div>

      {/* Load more trigger element */}
      <div ref={loadMoreRef} className="h-1" />

      {/* Loading indicator */}
      {isFetchingNextPage && <EntryListLoadingMore label="Loading more entries..." />}

      {/* End of list indicator */}
      {!hasNextPage && <EntryListEnd />}
    </div>
  );
}
