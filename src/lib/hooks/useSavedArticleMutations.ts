/**
 * useSavedArticleMutations Hook
 *
 * Provides saved article mutations (markRead, star, unstar) with optimistic updates.
 * Consolidates mutation logic from page components.
 */

"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";

/**
 * Filters for the current saved article list.
 * Used to target optimistic updates to the correct cache entry.
 */
interface SavedArticleListFilters {
  /**
   * Show only unread articles.
   */
  unreadOnly?: boolean;

  /**
   * Show only starred articles.
   */
  starredOnly?: boolean;

  /**
   * Sort order for articles.
   */
  sortOrder?: "newest" | "oldest";
}

/**
 * Options for the useSavedArticleMutations hook.
 */
export interface UseSavedArticleMutationsOptions {
  /**
   * Query filters for optimistic updates to the current list.
   * If not provided, mutations will work but without list optimistic updates.
   */
  listFilters?: SavedArticleListFilters;
}

/**
 * Result of the useSavedArticleMutations hook.
 */
export interface UseSavedArticleMutationsResult {
  /**
   * Mark one or more articles as read or unread.
   */
  markRead: (ids: string[], read: boolean) => void;

  /**
   * Toggle the read status of an article.
   */
  toggleRead: (articleId: string, currentlyRead: boolean) => void;

  /**
   * Star an article.
   */
  star: (articleId: string) => void;

  /**
   * Unstar an article.
   */
  unstar: (articleId: string) => void;

  /**
   * Toggle the starred status of an article.
   */
  toggleStar: (articleId: string, currentlyStarred: boolean) => void;

  /**
   * Whether any mutation is currently in progress.
   */
  isPending: boolean;

  /**
   * Whether the markRead mutation is pending.
   */
  isMarkReadPending: boolean;

  /**
   * Whether the star/unstar mutation is pending.
   */
  isStarPending: boolean;
}

/**
 * Hook that provides saved article mutations with optimistic updates.
 *
 * Consolidates the mutation logic that was previously duplicated
 * across page components.
 *
 * @param options - Options including list filters for optimistic updates
 * @returns Object with mutation functions and pending state
 */
export function useSavedArticleMutations(
  options?: UseSavedArticleMutationsOptions
): UseSavedArticleMutationsResult {
  const utils = trpc.useUtils();
  const listFilters = options?.listFilters;

  // Build the query key for the saved articles list (using entries endpoint with type='saved')
  const queryFilters = useMemo(
    () => ({
      type: "saved" as const,
      unreadOnly: listFilters?.unreadOnly,
      starredOnly: listFilters?.starredOnly,
      sortOrder: listFilters?.sortOrder,
    }),
    [listFilters?.unreadOnly, listFilters?.starredOnly, listFilters?.sortOrder]
  );

  // markRead mutation with optimistic updates
  // Uses entries.markRead endpoint which works for both feed entries and saved articles
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

      // Optimistically update list (normy propagates to entries.get automatically)
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
      // Rollback to previous state
      if (context?.previousData && listFilters) {
        utils.entries.list.setInfiniteData(queryFilters, context.previousData);
      }
      toast.error("Failed to update read status");
    },
    onSettled: () => {
      // Invalidate saved articles count
      utils.entries.count.invalidate({ type: "saved" });
    },
  });

  // star mutation with optimistic updates
  // Uses entries.star endpoint which works for both feed entries and saved articles
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
      // Rollback list
      if (context?.previousData && listFilters) {
        utils.entries.list.setInfiniteData(queryFilters, context.previousData);
      }
      toast.error("Failed to star article");
    },
  });

  // unstar mutation with optimistic updates
  // Uses entries.unstar endpoint which works for both feed entries and saved articles
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
      // Rollback list
      if (context?.previousData && listFilters) {
        utils.entries.list.setInfiniteData(queryFilters, context.previousData);
      }
      toast.error("Failed to unstar article");
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
    (articleId: string, currentlyRead: boolean) => {
      markReadMutation.mutate({ ids: [articleId], read: !currentlyRead });
    },
    [markReadMutation]
  );

  const star = useCallback(
    (articleId: string) => {
      starMutation.mutate({ id: articleId });
    },
    [starMutation]
  );

  const unstar = useCallback(
    (articleId: string) => {
      unstarMutation.mutate({ id: articleId });
    },
    [unstarMutation]
  );

  const toggleStar = useCallback(
    (articleId: string, currentlyStarred: boolean) => {
      if (currentlyStarred) {
        unstarMutation.mutate({ id: articleId });
      } else {
        starMutation.mutate({ id: articleId });
      }
    },
    [starMutation, unstarMutation]
  );

  const isPending =
    markReadMutation.isPending || starMutation.isPending || unstarMutation.isPending;
  const isMarkReadPending = markReadMutation.isPending;
  const isStarPending = starMutation.isPending || unstarMutation.isPending;

  return useMemo(
    () => ({
      markRead,
      toggleRead,
      star,
      unstar,
      toggleStar,
      isPending,
      isMarkReadPending,
      isStarPending,
    }),
    [markRead, toggleRead, star, unstar, toggleStar, isPending, isMarkReadPending, isStarPending]
  );
}
