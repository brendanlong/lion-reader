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
import { useRealtimeStore } from "@/lib/store/realtime";

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

  // markRead mutation with Zustand optimistic updates
  // Uses entries.markRead endpoint which works for both feed entries and saved articles
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

        // Look up the entry in the cache to find its subscriptionId
        const infiniteData = utils.entries.list.getInfiniteData(queryFilters);

        // Find the entry in the cached pages
        for (const page of infiniteData?.pages ?? []) {
          const entry = page.items.find((item) => item.id === entryId);
          if (entry?.subscriptionId) {
            subscriptionId = entry.subscriptionId;
            break;
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
          if (process.env.NODE_ENV === "development") {
            console.warn("⚠️  markRead (saved): subscriptionId not found for entry", {
              entryId,
              queryFilters,
              cacheHasData: !!infiniteData,
              pageCount: infiniteData?.pages?.length ?? 0,
            });
          }
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

  // star mutation with Zustand optimistic updates
  // Uses entries.star endpoint which works for both feed entries and saved articles
  const starMutation = trpc.entries.star.useMutation({
    onMutate: async (variables) => {
      // Update Zustand for instant UI feedback
      useRealtimeStore.getState().toggleStar(variables.id, false);
    },
    onError: () => {
      // On error, reset Zustand and refetch
      useRealtimeStore.getState().reset();
      utils.entries.list.invalidate();
      toast.error("Failed to star article");
    },
    onSettled: () => {
      // Invalidate starred entries list and count
      utils.entries.list.invalidate({ starredOnly: true });
      utils.entries.count.invalidate({ starredOnly: true });
    },
  });

  // unstar mutation with Zustand optimistic updates
  // Uses entries.unstar endpoint which works for both feed entries and saved articles
  const unstarMutation = trpc.entries.unstar.useMutation({
    onMutate: async (variables) => {
      // Update Zustand for instant UI feedback
      useRealtimeStore.getState().toggleStar(variables.id, true);
    },
    onError: () => {
      // On error, reset Zustand and refetch
      useRealtimeStore.getState().reset();
      utils.entries.list.invalidate();
      toast.error("Failed to unstar article");
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
