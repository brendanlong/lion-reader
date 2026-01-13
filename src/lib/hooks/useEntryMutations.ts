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

  // Build the query key for the entries list
  // This must match the filters used by the EntryList component
  const queryFilters = useMemo(
    () => ({
      subscriptionId: listFilters?.subscriptionId,
      tagId: listFilters?.tagId,
      uncategorized: listFilters?.uncategorized,
      unreadOnly: listFilters?.unreadOnly,
      starredOnly: listFilters?.starredOnly,
      sortOrder: listFilters?.sortOrder,
    }),
    [
      listFilters?.subscriptionId,
      listFilters?.tagId,
      listFilters?.uncategorized,
      listFilters?.unreadOnly,
      listFilters?.starredOnly,
      listFilters?.sortOrder,
    ]
  );

  // markRead mutation with Zustand optimistic updates
  const markReadMutation = trpc.entries.markRead.useMutation({
    onMutate: async (variables) => {
      // Update Zustand for instant UI feedback
      const markFn = variables.read
        ? useRealtimeStore.getState().markRead
        : useRealtimeStore.getState().markUnread;

      // Mark each entry (needs subscriptionId for count tracking)
      // If we have a subscriptionId filter, use it; otherwise skip count updates
      if (listFilters?.subscriptionId) {
        for (const entryId of variables.ids) {
          markFn(entryId, listFilters.subscriptionId);
        }
      } else {
        // For "All" view without specific subscription, just track read state
        // (count deltas will come from SSE/polling instead)
        for (const entryId of variables.ids) {
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

      // Also invalidate React Query for backward compatibility
      // TODO: Remove once components use Zustand deltas
      utils.entries.list.invalidate();
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
    },
    onError: () => {
      // On error, reset and refetch
      // TODO: Implement proper rollback once we have Zustand snapshot support
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

  // star mutation with optimistic updates
  const starMutation = trpc.entries.star.useMutation({
    onMutate: async (variables) => {
      // Skip optimistic updates if no list filters provided
      if (!listFilters) {
        return { previousData: undefined };
      }

      await utils.entries.list.cancel();

      const previousData = utils.entries.list.getInfiniteData(queryFilters);

      // Optimistically update list (normy propagates to entries.get automatically)
      utils.entries.list.setInfiniteData(queryFilters, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              item.id === variables.id ? { ...item, starred: true } : item
            ),
          })),
        };
      });

      return { previousData };
    },
    onSuccess: (data) => {
      // Update starred count directly - total increases by 1, unread increases if entry is unread
      utils.entries.count.setData({ starredOnly: true }, (old) => {
        if (!old) return old;
        return {
          total: old.total + 1,
          unread: old.unread + (data.entry.read ? 0 : 1),
        };
      });
    },
    onError: (_error, _variables, context) => {
      // Rollback list (normy propagates rollback to entries.get automatically)
      if (context?.previousData && listFilters) {
        utils.entries.list.setInfiniteData(queryFilters, context.previousData);
      }
      toast.error("Failed to star entry");
    },
    onSettled: () => {
      // Invalidate starred entries list so the Starred page shows the new item
      utils.entries.list.invalidate({ starredOnly: true });
    },
  });

  // unstar mutation with optimistic updates
  const unstarMutation = trpc.entries.unstar.useMutation({
    onMutate: async (variables) => {
      // Skip optimistic updates if no list filters provided
      if (!listFilters) {
        return { previousData: undefined };
      }

      await utils.entries.list.cancel();

      const previousData = utils.entries.list.getInfiniteData(queryFilters);

      // Optimistically update list (normy propagates to entries.get automatically)
      utils.entries.list.setInfiniteData(queryFilters, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            items: page.items
              .map((item) => (item.id === variables.id ? { ...item, starred: false } : item))
              // Filter out entries that no longer match the starredOnly filter
              .filter((item) => {
                if (listFilters?.starredOnly && !item.starred) {
                  return false;
                }
                return true;
              }),
          })),
        };
      });

      return { previousData };
    },
    onSuccess: (data) => {
      // Update starred count directly - total decreases by 1, unread decreases if entry is unread
      utils.entries.count.setData({ starredOnly: true }, (old) => {
        if (!old) return old;
        return {
          total: Math.max(0, old.total - 1),
          unread: Math.max(0, old.unread - (data.entry.read ? 0 : 1)),
        };
      });
    },
    onError: (_error, _variables, context) => {
      // Rollback list (normy propagates rollback to entries.get automatically)
      if (context?.previousData && listFilters) {
        utils.entries.list.setInfiniteData(queryFilters, context.previousData);
      }
      toast.error("Failed to unstar entry");
    },
    onSettled: () => {
      // Invalidate starred entries list so the Starred page reflects the removal
      utils.entries.list.invalidate({ starredOnly: true });
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
