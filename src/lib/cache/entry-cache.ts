/**
 * Entry Cache Helpers
 *
 * Functions for updating entry state in React Query cache.
 *
 * Strategy:
 * - For individual entry views (entries.get): update directly
 * - For entry lists (entries.list): invalidate (too many filter combinations to update all)
 * - For counts (subscriptions, tags): update directly via count-cache helpers
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";

/**
 * Updates read status for entries in the single entry cache (entries.get).
 * Also invalidates entry lists since they have too many filter combinations.
 *
 * Note: Call adjustSubscriptionUnreadCounts and adjustTagUnreadCounts separately
 * for count updates - those update directly without invalidation.
 *
 * @param utils - tRPC utils for cache access
 * @param entryIds - Entry IDs to update
 * @param read - New read status
 */
export function updateEntriesReadStatus(
  utils: TRPCClientUtils,
  entryIds: string[],
  read: boolean
): void {
  // Update individual entries.get caches - these are keyed by entry ID
  for (const entryId of entryIds) {
    utils.entries.get.setData({ id: entryId }, (oldData) => {
      if (!oldData) return oldData;
      return {
        ...oldData,
        entry: { ...oldData.entry, read },
      };
    });
  }

  // Invalidate entry lists - they'll refetch with the new read status
  // This is simpler than trying to update all possible filter combinations
  utils.entries.list.invalidate();
}

/**
 * Updates starred status for an entry in the single entry cache.
 * Also invalidates entry lists.
 *
 * @param utils - tRPC utils for cache access
 * @param entryId - Entry ID to update
 * @param starred - New starred status
 */
export function updateEntryStarredStatus(
  utils: TRPCClientUtils,
  entryId: string,
  starred: boolean
): void {
  // Update entries.get cache
  utils.entries.get.setData({ id: entryId }, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      entry: { ...oldData.entry, starred },
    };
  });

  // Invalidate entry lists - starred/unstarred entries need list updates
  utils.entries.list.invalidate();
}
