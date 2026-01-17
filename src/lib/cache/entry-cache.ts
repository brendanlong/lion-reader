/**
 * Entry Cache Helpers
 *
 * Functions for updating entry state in React Query cache.
 *
 * Strategy:
 * - For individual entry views (entries.get): update directly
 * - For entry lists (entries.list): don't invalidate - entries stay visible until navigation
 *   (lists have refetchOnMount: true, so they'll refetch on next navigation)
 * - For counts (subscriptions, tags): update directly via count-cache helpers
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";

/**
 * Updates read status for entries in the single entry cache (entries.get).
 * Does NOT invalidate entry lists - entries stay visible until navigation.
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

  // Don't invalidate entry lists - entries stay visible until navigation.
  // Lists have refetchOnMount: true, so they'll refetch on next navigation.
}

/**
 * Updates starred status for an entry in the single entry cache.
 * Does NOT invalidate entry lists - entries stay visible until navigation.
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

  // Don't invalidate entry lists - entries stay visible until navigation.
  // Lists have refetchOnMount: true, so they'll refetch on next navigation.
}
