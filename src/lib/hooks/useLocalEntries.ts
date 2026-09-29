/**
 * Hooks that render entries from the local normalized store
 * (`src/lib/local-db/`). Entry state lives in one row per entry, so every
 * view of an entry — each list it's in, the reader, the loading fallbacks —
 * updates from a single write.
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { coalesce, eq, inArray } from "@tanstack/db";
import { getLocalDb, type LocalDb } from "@/lib/local-db/local-db";
import { entryListKey, isNewestFirst, type EntryListFilters } from "@/lib/local-db/entry-lists";
import type { EntryRow } from "@/lib/local-db/entries";

function useLocalDb(): LocalDb {
  return getLocalDb(useQueryClient());
}

/** The entries of a loaded `entries.list` view, in list order. */
export function useEntryListEntries(input: EntryListFilters): EntryRow[] {
  const db = useLocalDb();
  const listKey = entryListKey(input);
  const newestFirst = isNewestFirst(input);
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
        .orderBy(({ member }) => member.order, "asc")
        .orderBy(({ member }) => member.entryId, newestFirst ? "desc" : "asc")
        .select(({ entry }) => entry),
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

/**
 * Entries already in the store that match a list view's filters, newest
 * first — shown while the view's own first page loads. `subscriptionIds`
 * narrows tag/uncategorized views (their membership depends on subscription
 * tags); pass `null` to disable the query when those aren't known.
 */
export function useLocalEntriesMatching(
  filters: EntryListFilters,
  subscriptionIds: string[] | undefined | null
): EntryRow[] | undefined {
  const db = useLocalDb();
  const newestFirst = isNewestFirst(filters);
  const { data } = useLiveQuery({
    query: (q) => {
      if (subscriptionIds === null) return undefined;
      let query = q.from({ entry: db.entries.collection });
      if (filters.subscriptionId) {
        const { subscriptionId } = filters;
        query = query.where(({ entry }) => eq(entry.subscriptionId, subscriptionId));
      }
      if (subscriptionIds) {
        query = query.where(({ entry }) => inArray(entry.subscriptionId, subscriptionIds));
      }
      if (filters.starredOnly) query = query.where(({ entry }) => eq(entry.starred, true));
      if (filters.unreadOnly) query = query.where(({ entry }) => eq(entry.read, false));
      if (filters.type) {
        const { type } = filters;
        query = query.where(({ entry }) => eq(entry.type, type));
      }
      const direction = newestFirst ? "desc" : "asc";
      return query
        .orderBy(({ entry }) => coalesce(entry.publishedAt, entry.fetchedAt), direction)
        .orderBy(({ entry }) => entry.id, direction)
        .limit(50);
    },
  });
  return data;
}
