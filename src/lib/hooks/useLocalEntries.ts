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
  entryListKey,
  entryMatchesList,
  entryMembershipScope,
  isNewestFirst,
  type EntryListFilters,
} from "@/lib/local-db/entry-lists";
import { useLocalSubscriptions } from "@/lib/hooks/useLocalSubscriptions";
import type { EntryRow } from "@/lib/local-db/entries";

function useLocalDb(): LocalDb {
  return getLocalDb(useQueryClient());
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

/** How many stored entries `useLocalEntriesMatching` shows. */
const MATCHING_ENTRIES_LIMIT = 50;

/**
 * Entries already in the store that match a list view's filters, in list
 * order — shown while the view's own first page loads. Tag, Uncategorized and
 * Saved membership come from the stored subscriptions and the saved
 * subscription's id, so nothing matches those views until they're known.
 */
export function useLocalEntriesMatching(filters: EntryListFilters): EntryRow[] {
  const db = useLocalDb();
  const savedSubscriptionId = useSavedSubscriptionId();
  const subscriptions = useLocalSubscriptions();
  const { data: entries } = useLiveQuery({
    query: (q) => q.from({ entry: db.entries.collection }),
  });
  // Callers pass a fresh object each render, so the memo keys on its fields.
  const { subscriptionId, tagId, uncategorized, starredOnly, unreadOnly, type, sortOrder } =
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
    };
    const needsScope = !!tagId || !!uncategorized || type === "saved";
    const tagIds = new Map(
      needsScope ? subscriptions.map((row) => [row.id, row.tags.map((tag) => tag.id)] as const) : []
    );
    const noScope = { tagIds: new Set<string>(), uncategorized: false, saved: false };
    return entries
      .filter((entry) =>
        entryMatchesList(
          input,
          entry,
          needsScope
            ? entryMembershipScope(entry.subscriptionIds, savedSubscriptionId, (id) =>
                tagIds.get(id)
              )
            : noScope
        )
      )
      .sort(compareListEntries(input))
      .slice(0, MATCHING_ENTRIES_LIMIT);
  }, [
    entries,
    subscriptions,
    savedSubscriptionId,
    subscriptionId,
    tagId,
    uncategorized,
    starredOnly,
    unreadOnly,
    type,
    sortOrder,
  ]);
}
