/**
 * useEntryMutations Hook
 *
 * Provides entry mutations (markRead, star, unstar) with optimistic updates
 * for the entry list. Consolidates mutation logic from page components.
 */

"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useRealtimeStore } from "@/lib/store/realtime";

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
   */
  markRead: (ids: string[], read: boolean) => void;

  /**
   * Toggle the read status of an entry.
   */
  toggleRead: (entryId: string, currentlyRead: boolean) => void;

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
 * Hook that provides entry mutations with optimistic updates.
 *
 * Consolidates the mutation logic that was previously duplicated
 * across page components (all, feed, starred, tag).
 *
 * @param options - Options including list filters for optimistic updates
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
export function useEntryMutations(options?: UseEntryMutationsOptions): UseEntryMutationsResult {
  const utils = trpc.useUtils();
  const listFilters = options?.listFilters;

  // markRead mutation with Zustand optimistic updates
  const markReadMutation = trpc.entries.markRead.useMutation({
    onMutate: async (variables) => {
      // Update Zustand for instant UI feedback
      const markFn = variables.read
        ? useRealtimeStore.getState().markRead
        : useRealtimeStore.getState().markUnread;

      // Get subscriptions data to look up tag IDs
      const subscriptionsData = utils.subscriptions.list.getData();

      // Mark each entry with proper subscription and tag tracking
      for (const entryId of variables.ids) {
        let subscriptionId: string | undefined;
        let tagIds: string[] | undefined;

        // First, try to get subscriptionId from listFilters (feed view)
        if (listFilters?.subscriptionId) {
          subscriptionId = listFilters.subscriptionId;
        } else {
          // Otherwise, look up the entry in the cache to find its subscriptionId
          // This handles tag view, uncategorized view, and all view
          const infiniteData = utils.entries.list.getInfiniteData({
            subscriptionId: listFilters?.subscriptionId,
            tagId: listFilters?.tagId,
            uncategorized: listFilters?.uncategorized,
            unreadOnly: listFilters?.unreadOnly,
            starredOnly: listFilters?.starredOnly,
            sortOrder: listFilters?.sortOrder,
          });

          // Find the entry in the cached pages
          for (const page of infiniteData?.pages ?? []) {
            const entry = page.items.find((item) => item.id === entryId);
            if (entry?.subscriptionId) {
              subscriptionId = entry.subscriptionId;
              break;
            }
          }
        }

        // If we found a subscriptionId, look up its tags
        if (subscriptionId && subscriptionsData) {
          const subscription = subscriptionsData.items.find((sub) => sub.id === subscriptionId);
          if (subscription) {
            tagIds = subscription.tags.map((tag) => tag.id);
          }
        }

        // Update Zustand with subscription and tag tracking
        if (subscriptionId) {
          markFn(entryId, subscriptionId, tagIds);
        } else {
          // Fallback: just track read state without count updates
          if (variables.read) {
            useRealtimeStore.setState((s) => ({
              readIds: new Set([...s.readIds, entryId]),
            }));
          } else {
            useRealtimeStore.setState((s) => ({
              unreadIds: new Set([...s.unreadIds, entryId]),
            }));
          }
        }
      }
      // No React Query invalidations needed - UI updates via Zustand deltas
    },
    onSuccess: () => {
      // Invalidate starred count since marking read/unread affects starred unread count
      // We don't track starred count deltas in Zustand, so just refetch
      utils.entries.count.invalidate({ starredOnly: true });
    },
    onError: () => {
      // On error, reset Zustand and refetch server data
      useRealtimeStore.getState().reset();
      utils.entries.list.invalidate();
      utils.subscriptions.list.invalidate();
      toast.error("Failed to update read status");
    },
  });

  // markAllRead mutation - marks all entries matching filters as read
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

  // star mutation with Zustand optimistic updates
  const starMutation = trpc.entries.star.useMutation({
    onMutate: async (variables) => {
      // Update Zustand for instant UI feedback
      useRealtimeStore.getState().toggleStar(variables.id, false);
    },
    onError: () => {
      // On error, reset Zustand and refetch
      useRealtimeStore.getState().reset();
      utils.entries.list.invalidate();
      toast.error("Failed to star entry");
    },
    onSettled: () => {
      // Invalidate starred entries list and count
      utils.entries.list.invalidate({ starredOnly: true });
      utils.entries.count.invalidate({ starredOnly: true });
    },
  });

  // unstar mutation with Zustand optimistic updates
  const unstarMutation = trpc.entries.unstar.useMutation({
    onMutate: async (variables) => {
      // Update Zustand for instant UI feedback
      useRealtimeStore.getState().toggleStar(variables.id, true);
    },
    onError: () => {
      // On error, reset Zustand and refetch
      useRealtimeStore.getState().reset();
      utils.entries.list.invalidate();
      toast.error("Failed to unstar entry");
    },
    onSettled: () => {
      // Invalidate starred entries list and count
      utils.entries.list.invalidate({ starredOnly: true });
      utils.entries.count.invalidate({ starredOnly: true });
    },
  });

  // Convenience wrapper functions
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
