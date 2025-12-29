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

/**
 * Filters for the current entry list.
 * Used to target optimistic updates to the correct cache entry.
 */
export interface EntryListFilters {
  /**
   * Filter by specific feed ID.
   */
  feedId?: string;

  /**
   * Filter by specific tag ID.
   */
  tagId?: string;

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
      feedId: listFilters?.feedId,
      tagId: listFilters?.tagId,
      unreadOnly: listFilters?.unreadOnly,
      starredOnly: listFilters?.starredOnly,
      sortOrder: listFilters?.sortOrder,
    }),
    [
      listFilters?.feedId,
      listFilters?.tagId,
      listFilters?.unreadOnly,
      listFilters?.starredOnly,
      listFilters?.sortOrder,
    ]
  );

  // markRead mutation with optimistic updates
  const markReadMutation = trpc.entries.markRead.useMutation({
    onMutate: async (variables) => {
      // Skip optimistic updates if no list filters provided
      if (!listFilters) {
        return { previousData: undefined };
      }

      // Cancel any in-flight queries
      await utils.entries.list.cancel();

      // Snapshot current state for rollback
      const previousData = utils.entries.list.getInfiniteData(queryFilters);

      // Optimistically update entries (normy propagates to entries.get automatically)
      utils.entries.list.setInfiniteData(queryFilters, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          pages: oldData.pages.map((page) => ({
            ...page,
            items: page.items.map((item) =>
              variables.ids.includes(item.id) ? { ...item, read: variables.read } : item
            ),
          })),
        };
      });

      return { previousData };
    },
    onError: (_error, _variables, context) => {
      // Rollback to previous state (normy propagates rollback to entries.get automatically)
      if (context?.previousData && listFilters) {
        utils.entries.list.setInfiniteData(queryFilters, context.previousData);
      }
      toast.error("Failed to update read status");
    },
    onSettled: () => {
      // Invalidate subscription counts as they need server data
      utils.subscriptions.list.invalidate();
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
      // Invalidate subscriptions to update unread counts
      utils.subscriptions.list.invalidate();
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
            items: page.items.map((item) =>
              item.id === variables.id ? { ...item, starred: false } : item
            ),
          })),
        };
      });

      return { previousData };
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
      // Invalidate subscriptions to update unread counts
      utils.subscriptions.list.invalidate();
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
    markReadMutation.isPending || starMutation.isPending || unstarMutation.isPending;

  return useMemo(
    () => ({
      markRead,
      toggleRead,
      star,
      unstar,
      toggleStar,
      isPending,
    }),
    [markRead, toggleRead, star, unstar, toggleStar, isPending]
  );
}
