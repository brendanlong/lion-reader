/**
 * Hooks that render entries from the local normalized store
 * (`src/lib/local-db/`). Entry state lives in one row per entry, so every
 * view of an entry — each list it's in, the reader, the loading fallbacks —
 * updates from a single write.
 */

"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { coalesce, eq } from "@tanstack/db";
import { getLocalDb, subscribeSavedSubscriptionId, type LocalDb } from "@/lib/local-db/local-db";
import { entryListKey, isNewestFirst, type EntryListFilters } from "@/lib/local-db/entry-lists";
import type { EntryRow } from "@/lib/local-db/entries";

function useLocalDb(): LocalDb {
  return getLocalDb(useQueryClient());
}

/** The saved subscription's id as the store knows it (`LocalDb.saved`), re-rendering when learned. */
function useStoredSavedSubscriptionId(db: LocalDb): string | null | undefined {
  const subscribe = useCallback(
    (listener: () => void) => subscribeSavedSubscriptionId(db, listener),
    [db]
  );
  const read = () => db.saved.id;
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * The entries of a loaded `entries.list` view, in list order. `openEntryId`
 * is listed even if it left the list's collection (`ListEntryRow.removed`).
 */
export function useEntryListEntries(
  input: EntryListFilters,
  openEntryId: string | null
): EntryRow[] {
  const db = useLocalDb();
  const listKey = entryListKey(input);
  const newestFirst = isNewestFirst(input);
  // Filtered outside the live query so opening another entry doesn't rebuild it.
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
        .select(({ member, entry }) => ({ removed: member.removed, entry })),
  });
  return useMemo(
    () =>
      data.filter((row) => !row.removed || row.entry.id === openEntryId).map((row) => row.entry),
    [data, openEntryId]
  );
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
 * first — shown while the view's own first page loads. Membership filters go
 * by the entries' `subscriptionIds`: `subscriptionIds` narrows tag and
 * uncategorized views to the stored subscriptions that qualify (pass `null` to
 * disable the query when those aren't known), and Saved needs the saved
 * subscription's id (nothing matches until it's known).
 */
export function useLocalEntriesMatching(
  filters: EntryListFilters,
  subscriptionIds: string[] | undefined | null
): EntryRow[] | undefined {
  const db = useLocalDb();
  const newestFirst = isNewestFirst(filters);
  const savedSubscriptionId = useStoredSavedSubscriptionId(db);
  const { subscriptionId, type, starredOnly, unreadOnly } = filters;
  const { data } = useLiveQuery({
    // The membership filters are functions, which the query's own identity
    // can't see: this key is what rebuilds it.
    queryKey: [
      "entries-matching",
      subscriptionId,
      type,
      starredOnly,
      unreadOnly,
      newestFirst,
      subscriptionIds,
      savedSubscriptionId,
    ],
    query: (q) => {
      if (subscriptionIds === null) return undefined;
      let query = q.from({ entry: db.entries.collection });
      // Nothing is in Saved until its subscription is known.
      const memberOf =
        subscriptionId ?? (type === "saved" ? (savedSubscriptionId ?? null) : undefined);
      if (memberOf !== undefined) {
        query = query.fn.where(
          ({ entry }) => !!memberOf && entry.subscriptionIds.includes(memberOf)
        );
      }
      if (subscriptionIds) {
        const scope = new Set(subscriptionIds);
        query = query.fn.where(({ entry }) => entry.subscriptionIds.some((id) => scope.has(id)));
      }
      if (starredOnly) query = query.where(({ entry }) => eq(entry.starred, true));
      if (unreadOnly) query = query.where(({ entry }) => eq(entry.read, false));
      if (type && type !== "saved") query = query.where(({ entry }) => eq(entry.type, type));
      const direction = newestFirst ? "desc" : "asc";
      return query
        .orderBy(({ entry }) => coalesce(entry.publishedAt, entry.fetchedAt), direction)
        .orderBy(({ entry }) => entry.id, direction)
        .limit(50);
    },
  });
  return data;
}
