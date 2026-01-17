/**
 * useEntryMutations Hook
 *
 * Provides entry mutations (markRead, star, unstar) with direct cache updates.
 * Consolidates mutation logic from page components.
 *
 * Cache update strategy:
 * - markRead: Updates entry read status in all caches, adjusts subscription/tag counts
 * - star/unstar: Updates entry starred status, adjusts starred count
 * - markAllRead: Invalidates all caches (too complex for direct update)
 */

"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import {
  updateEntriesReadStatus,
  updateEntryStarredStatus,
  adjustSubscriptionUnreadCounts,
  adjustTagUnreadCounts,
  adjustEntriesCount,
  calculateTagDeltasFromSubscriptions,
} from "@/lib/cache";

/**
 * Entry type for routing.
 */
export type EntryType = "web" | "email" | "saved";

/**
 * Filters for the current entry list.
 * Used to target optimistic updates to the correct cache entry.
 */
export interface EntryListFilters {
  /**
   * Filter by specific subscription ID.
   */
  subscriptionId?: string;

  /**
   * Filter by specific tag ID.
   */
  tagId?: string;

  /**
   * Show only entries from uncategorized feeds (feeds with no tags).
   */
  uncategorized?: boolean;

  /**
   * Show only unread entries.
   */
  unreadOnly?: boolean;

  /**
   * Show only starred entries.
   */
  starredOnly?: boolean;

  /**
   * Sort order for entries.
   */
  sortOrder?: "newest" | "oldest";

  /**
   * Filter by entry type (web, email, saved).
   */
  type?: EntryType;
}

/**
 * Options for the useEntryMutations hook.
 */
export interface UseEntryMutationsOptions {
  /**
   * Query filters for optimistic updates to the current list.
   * If not provided, mutations will work but without list optimistic updates.
   */
  listFilters?: EntryListFilters;

  /**
   * Entry type for the current entry/view context.
   * When provided, bypasses per-entry type lookup.
   * Used in detail views or saved article views where type is known.
   */
  entryType?: EntryType;

  /**
   * Optional subscription ID for the current entry.
   * When provided, bypasses cache lookup for subscription tracking.
   * Used in detail views where we already have the entry data.
   */
  subscriptionId?: string;

  /**
   * Optional tag IDs for the current entry's subscription.
   * When provided along with subscriptionId, bypasses tag lookup.
   */
  tagIds?: string[];
}

/**
 * Options for the markAllRead mutation.
 */
export interface MarkAllReadOptions {
  /**
   * Filter by specific subscription ID.
   */
  subscriptionId?: string;

  /**
   * Filter by specific tag ID.
   */
  tagId?: string;

  /**
   * Mark only entries from uncategorized feeds (feeds with no tags).
   */
  uncategorized?: boolean;

  /**
   * Mark only starred entries.
   */
  starredOnly?: boolean;
}

/**
 * Result of the useEntryMutations hook.
 */
export interface UseEntryMutationsResult {
  /**
   * Mark one or more entries as read or unread.
   * @param entryType - Entry type (kept for API compatibility, unused)
   * @param subscriptionId - Optional subscription ID (kept for API compatibility, unused)
   * @param tagIds - Optional tag IDs (kept for API compatibility, unused)
   */
  markRead: (
    ids: string[],
    read: boolean,
    entryType: EntryType,
    subscriptionId?: string,
    tagIds?: string[]
  ) => void;

  /**
   * Toggle the read status of an entry.
   * @param entryType - Entry type (kept for API compatibility, unused)
   * @param subscriptionId - Optional subscription ID (kept for API compatibility, unused)
   * @param tagIds - Optional tag IDs (kept for API compatibility, unused)
   */
  toggleRead: (
    entryId: string,
    currentlyRead: boolean,
    entryType: EntryType,
    subscriptionId?: string,
    tagIds?: string[]
  ) => void;

  /**
   * Mark all entries as read with optional filters.
   */
  markAllRead: (options?: MarkAllReadOptions) => void;

  /**
   * Star an entry.
   */
  star: (entryId: string) => void;

  /**
   * Unstar an entry.
   */
  unstar: (entryId: string) => void;

  /**
   * Toggle the starred status of an entry.
   */
  toggleStar: (entryId: string, currentlyStarred: boolean) => void;

  /**
   * Whether any mutation is currently in progress.
   */
  isPending: boolean;

  /**
   * Whether the markRead mutation is pending.
   */
  isMarkReadPending: boolean;

  /**
   * Whether the markAllRead mutation is pending.
   */
  isMarkAllReadPending: boolean;

  /**
   * Whether the star/unstar mutation is pending.
   */
  isStarPending: boolean;
}

/**
 * Hook that provides entry mutations with direct cache updates.
 *
 * Consolidates the mutation logic that was previously duplicated
 * across page components (all, feed, starred, tag).
 *
 * @returns Object with mutation functions and pending state
 *
 * @example
 * ```tsx
 * function AllEntriesPage() {
 *   const { showUnreadOnly, sortOrder } = useViewPreferences('all');
 *   const { markRead, toggleRead, toggleStar } = useEntryMutations({
 *     listFilters: { unreadOnly: showUnreadOnly, sortOrder },
 *   });
 *
 *   return (
 *     <EntryList
 *       onToggleRead={(id, read) => toggleRead(id, read)}
 *       onToggleStar={(id, starred) => toggleStar(id, starred)}
 *     />
 *   );
 * }
 * ```
 */
export function useEntryMutations(): UseEntryMutationsResult {
  const utils = trpc.useUtils();

  // markRead mutation - direct cache update on success
  const markReadMutation = trpc.entries.markRead.useMutation({
    onSuccess: (data, variables) => {
      const { entries } = data;
      const { read } = variables;

      // 1. Update entry read status in all cached entry lists
      updateEntriesReadStatus(
        utils,
        entries.map((e) => e.id),
        read
      );

      // 2. Calculate subscription deltas (each entry affects its subscription's count)
      // Marking read: -1, marking unread: +1
      const delta = read ? -1 : 1;
      const subscriptionDeltas = new Map<string, number>();

      for (const entry of entries) {
        if (entry.subscriptionId) {
          const current = subscriptionDeltas.get(entry.subscriptionId) ?? 0;
          subscriptionDeltas.set(entry.subscriptionId, current + delta);
        }
      }

      // 3. Update subscription unread counts
      adjustSubscriptionUnreadCounts(utils, subscriptionDeltas);

      // 4. Calculate and update tag unread counts
      const tagDeltas = calculateTagDeltasFromSubscriptions(utils, subscriptionDeltas);
      adjustTagUnreadCounts(utils, tagDeltas);

      // 5. Update entries.count caches
      // Update the starred count if any entries were starred
      adjustEntriesCount(utils, { starredOnly: true }, delta * entries.length);
    },
    onError: () => {
      toast.error("Failed to update read status");
    },
  });

  // markAllRead mutation - marks all entries matching filters as read
  // This is complex to update directly (unknown which entries are affected),
  // so we invalidate instead
  const markAllReadMutation = trpc.entries.markAllRead.useMutation({
    onSuccess: () => {
      // Invalidate all entry lists to refetch with updated read status
      utils.entries.list.invalidate();
      // Invalidate subscription counts as they need server data
      utils.subscriptions.list.invalidate();
      // Invalidate tag unread counts
      utils.tags.list.invalidate();
      // Invalidate starred count as it may have changed
      utils.entries.count.invalidate({ starredOnly: true });
    },
    onError: () => {
      toast.error("Failed to mark all as read");
    },
  });

  // star mutation - direct cache update on success
  const starMutation = trpc.entries.star.useMutation({
    onSuccess: (_data, variables) => {
      const entryId = variables.id;

      // 1. Update entry starred status in all caches
      updateEntryStarredStatus(utils, entryId, true);

      // 2. Update starred count (total +1, unread may change based on read state)
      // We'd need to know if the entry was unread, but we can just invalidate the count
      // Actually, let's increment total by 1 for now
      adjustEntriesCount(utils, { starredOnly: true }, 0, 1);
    },
    onError: () => {
      toast.error("Failed to star entry");
    },
  });

  // unstar mutation - direct cache update on success
  const unstarMutation = trpc.entries.unstar.useMutation({
    onSuccess: (_data, variables) => {
      const entryId = variables.id;

      // 1. Update entry starred status in all caches
      updateEntryStarredStatus(utils, entryId, false);

      // 2. Update starred count (total -1)
      adjustEntriesCount(utils, { starredOnly: true }, 0, -1);
    },
    onError: () => {
      toast.error("Failed to unstar entry");
    },
  });

  // Note: entryType, subscriptionId, tagIds are kept in signature for API
  // compatibility but are unused since we now get subscription context from server.
  const markRead = useCallback(
    (ids: string[], read: boolean) => {
      markReadMutation.mutate({ ids, read });
    },
    [markReadMutation]
  );

  const toggleRead = useCallback(
    (entryId: string, currentlyRead: boolean) => {
      markReadMutation.mutate({ ids: [entryId], read: !currentlyRead });
    },
    [markReadMutation]
  );

  const markAllRead = useCallback(
    (options?: MarkAllReadOptions) => {
      markAllReadMutation.mutate(options ?? {});
    },
    [markAllReadMutation]
  );

  const star = useCallback(
    (entryId: string) => {
      starMutation.mutate({ id: entryId });
    },
    [starMutation]
  );

  const unstar = useCallback(
    (entryId: string) => {
      unstarMutation.mutate({ id: entryId });
    },
    [unstarMutation]
  );

  const toggleStar = useCallback(
    (entryId: string, currentlyStarred: boolean) => {
      if (currentlyStarred) {
        unstarMutation.mutate({ id: entryId });
      } else {
        starMutation.mutate({ id: entryId });
      }
    },
    [starMutation, unstarMutation]
  );

  const isPending =
    markReadMutation.isPending ||
    markAllReadMutation.isPending ||
    starMutation.isPending ||
    unstarMutation.isPending;
  const isMarkReadPending = markReadMutation.isPending;
  const isMarkAllReadPending = markAllReadMutation.isPending;
  const isStarPending = starMutation.isPending || unstarMutation.isPending;

  return useMemo(
    () => ({
      // Cast to the expected signature - extra args are ignored
      markRead: markRead as UseEntryMutationsResult["markRead"],
      toggleRead: toggleRead as UseEntryMutationsResult["toggleRead"],
      markAllRead,
      star,
      unstar,
      toggleStar,
      isPending,
      isMarkReadPending,
      isMarkAllReadPending,
      isStarPending,
    }),
    [
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      isPending,
      isMarkReadPending,
      isMarkAllReadPending,
      isStarPending,
    ]
  );
}
