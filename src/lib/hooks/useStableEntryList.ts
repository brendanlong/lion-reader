/**
 * useStableEntryList Hook
 *
 * Provides display stability for entry lists: entries that were visible
 * when the view loaded won't disappear when their state changes.
 *
 * Problem: If the user is viewing "unread only" and marks an entry as read,
 * the live query's `where` clause filters it out and it vanishes.
 *
 * Solution: Track which entries have been rendered ("seen"). When an entry
 * drops out of the live query results, look it up in the view collection
 * (which still has it) and merge it back into the display list.
 *
 * The seen set resets on navigation (when filterKey changes = new collection).
 *
 * Implementation: Uses an external store (useSyncExternalStore) to track
 * seen IDs, with a microtask-based recording mechanism to comply with
 * React 19's strict rules against side effects during render.
 */

"use client";

import { useMemo, useSyncExternalStore } from "react";
import type { SortedEntryListItem, ViewEntriesCollection } from "@/lib/collections/entries";

/**
 * External store that tracks seen entry IDs.
 * All mutations happen outside render (via microtask or subscribe callback).
 */
function createSeenIdsStore() {
  let seenIds = new Set<string>();
  let pendingIds: string[] | null = null;
  const listeners = new Set<() => void>();

  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot: () => seenIds,
    subscribe: (callback: () => void) => {
      listeners.add(callback);
      // Flush any pending IDs when a subscriber is added
      if (pendingIds) {
        const ids = pendingIds;
        pendingIds = null;
        let changed = false;
        for (const id of ids) {
          if (!seenIds.has(id)) {
            changed = true;
            break;
          }
        }
        if (changed) {
          seenIds = new Set(seenIds);
          for (const id of ids) {
            seenIds.add(id);
          }
          // Schedule notification to avoid sync issues
          queueMicrotask(notify);
        }
      }
      return () => listeners.delete(callback);
    },
    /** Schedule IDs to be recorded after render */
    scheduleSeen: (ids: string[]) => {
      pendingIds = ids;
      queueMicrotask(() => {
        if (!pendingIds) return;
        const toRecord = pendingIds;
        pendingIds = null;
        let changed = false;
        for (const id of toRecord) {
          if (!seenIds.has(id)) {
            changed = true;
            break;
          }
        }
        if (changed) {
          seenIds = new Set(seenIds);
          for (const id of toRecord) {
            seenIds.add(id);
          }
          notify();
        }
      });
    },
    reset: () => {
      pendingIds = null;
      if (seenIds.size > 0) {
        seenIds = new Set<string>();
        notify();
      }
    },
  };
}

/**
 * Merges live query results with previously-seen entries to prevent
 * entries from disappearing mid-session.
 *
 * @param liveEntries - Entries from useLiveInfiniteQuery (filtered by where clause)
 * @param viewCollection - The view collection (has ALL fetched entries, even state-changed ones)
 * @param filterKey - Changes on navigation, resetting the seen set
 * @param sortDescending - Whether to sort newest first (true) or oldest first (false)
 */
export function useStableEntryList(
  liveEntries: SortedEntryListItem[],
  viewCollection: ViewEntriesCollection,
  filterKey: string,
  sortDescending: boolean
): SortedEntryListItem[] {
  // Stable store per component instance — reset + recreate when filterKey changes
  // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional: recreate store on filter change
  const store = useMemo(() => createSeenIdsStore(), [filterKey]);

  // Subscribe to seen IDs changes
  const seenIds = useSyncExternalStore(store.subscribe, store.getSnapshot, () => new Set<string>());

  // Build the stable entry list by merging live entries with previously-seen ones
  const stableEntries = useMemo(() => {
    const liveIds = new Set(liveEntries.map((e) => e.id));
    const result: SortedEntryListItem[] = [...liveEntries];

    // Add back previously-seen entries that no longer match the filter
    for (const id of seenIds) {
      if (!liveIds.has(id)) {
        const entry = viewCollection.get(id) as SortedEntryListItem | undefined;
        if (entry) {
          result.push(entry);
        }
      }
    }

    // Re-sort to maintain consistent ordering
    if (sortDescending) {
      result.sort((a, b) => b._sortMs - a._sortMs || b.id.localeCompare(a.id));
    } else {
      result.sort((a, b) => a._sortMs - b._sortMs || a.id.localeCompare(b.id));
    }

    return result;
  }, [liveEntries, viewCollection, seenIds, sortDescending]);

  // Schedule recording of current entries as seen (runs after render via microtask)
  store.scheduleSeen(stableEntries.map((e) => e.id));

  return stableEntries;
}
