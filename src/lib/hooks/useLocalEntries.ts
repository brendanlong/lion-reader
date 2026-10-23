/**
 * Hooks that render entries from the local normalized store
 * (`src/lib/local-db/`). Entry state lives in one row per entry, so every
 * view of an entry — each list it's in, the reader, the loading fallbacks —
 * updates from a single write.
 */

"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { eq } from "@tanstack/db";
import { getLocalDb, type LocalDb } from "@/lib/local-db/local-db";
import { useSavedSubscriptionId } from "@/lib/hooks/useSavedSubscriptionId";
import {
  compareListEntries,
  comparePlaces,
  entryListKey,
  entryMatchesList,
  type EntryListFilters,
  type ListSortableRow,
} from "@/lib/local-db/entry-lists";
import type { EntryRow } from "@/lib/local-db/entries";
import { isRankedSort } from "@/lib/entry-sort";

function useLocalDb(): LocalDb {
  return getLocalDb(useQueryClient());
}

/**
 * The entries of a loaded `entries.list` view, in list order. `openEntryId`
 * is listed even if leaving a collection took it out of the list
 * (`ListEntryRow.removed`).
 */
export function useEntryListEntries(
  input: EntryListFilters,
  openEntryId: string | null
): EntryRow[] {
  const db = useLocalDb();
  const listKey = entryListKey(input);
  // Filtered and sorted outside the live query, so opening another entry
  // doesn't rebuild it, and a list's order has one implementation
  // (`comparePlaces`).
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ member: db.lists.rows.collection })
        .where(({ member }) => eq(member.listKey, listKey))
        .join(
          { entry: db.entries.collection },
          ({ member, entry }) => eq(member.entryId, entry.id),
          "inner"
        )
        .select(({ member, entry }) => ({
          removed: member.removed,
          order: member.order,
          entry,
        })),
  });
  return useMemo(
    () =>
      data
        .filter((row) => !row.removed || row.entry.id === openEntryId)
        .sort((a, b) =>
          comparePlaces(
            { order: a.order, entryId: a.entry.id },
            { order: b.order, entryId: b.entry.id }
          )
        )
        .map((row) => row.entry),
    [data, openEntryId]
  );
}

/**
 * Which ranked sorts a loaded list has values for: from its first page,
 * then kept current by live changes. Undefined until the first page lands,
 * and for lists that sort by nothing else (search, Recently Read).
 */
export function useListSortable(input: EntryListFilters): ListSortableRow | undefined {
  const db = useLocalDb();
  const listKey = entryListKey(input);
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ row: db.lists.sortable.collection })
        .where(({ row }) => eq(row.listKey, listKey))
        .findOne(),
  });
  return data;
}

/** One entry's list-item fields, or undefined when the store doesn't hold it. */
export function useLocalEntry(entryId: string): EntryRow | undefined {
  const db = useLocalDb();
  const { data } = useLiveQuery({
    query: (q) =>
      q
        .from({ entry: db.entries.collection })
        .where(({ entry }) => eq(entry.id, entryId))
        .findOne(),
  });
  return data;
}

/** How many stored entries `useLocalEntriesMatching` shows. */
const MATCHING_ENTRIES_LIMIT = 50;

/**
 * Entries already in the store that match a list view's filters, in list
 * order — shown while the view's own first page loads. Saved membership comes
 * from the saved subscription's id, so nothing matches Saved until it's known.
 */
export function useLocalEntriesMatching(filters: EntryListFilters): EntryRow[] {
  const db = useLocalDb();
  const savedSubscriptionId = useSavedSubscriptionId();
  const { data: entries } = useLiveQuery({
    query: (q) => q.from({ entry: db.entries.collection }),
  });
  // Callers pass a fresh object each render, so the memo keys on its fields.
  const { subscriptionId, tagId, uncategorized, starredOnly, unreadOnly, type, sortOrder, sortBy } =
    filters;
  return useMemo(() => {
    const input = {
      subscriptionId,
      tagId,
      uncategorized,
      starredOnly,
      unreadOnly,
      type,
      sortOrder,
      sortBy: isRankedSort(sortBy) ? sortBy : undefined,
    };
    return entries
      .filter((entry) => entryMatchesList(input, entry, savedSubscriptionId))
      .sort(compareListEntries(input))
      .slice(0, MATCHING_ENTRIES_LIMIT);
  }, [
    entries,
    savedSubscriptionId,
    subscriptionId,
    tagId,
    uncategorized,
    starredOnly,
    unreadOnly,
    type,
    sortOrder,
    sortBy,
  ]);
}
