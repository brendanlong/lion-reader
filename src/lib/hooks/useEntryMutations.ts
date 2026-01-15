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
import { useRealtimeStore, type EntryType } from "@/lib/store/realtime";

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
   * @param entryType - Entry type for count delta routing
   * @param subscriptionId - Optional subscription ID for count tracking (web/email only)
   * @param tagIds - Optional tag IDs for count tracking (web/email only)
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
   * @param entryType - Entry type for count delta routing
   * @param subscriptionId - Optional subscription ID for count tracking (web/email only)
   * @param tagIds - Optional tag IDs for count tracking (web/email only)
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
  const knownEntryType = options?.entryType;
  const knownSubscriptionId = options?.subscriptionId;
  const knownTagIds = options?.tagIds;

  // markRead mutation - Zustand updates happen synchronously in wrapper functions
  // This avoids the fragile ref pattern that could race with async onMutate
  const markReadMutation = trpc.entries.markRead.useMutation({
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

  // Wrapper functions that perform Zustand updates synchronously before the mutation
  // This is more reliable than onMutate which can have timing issues with refs
  const markRead = useCallback(
    (
      ids: string[],
      read: boolean,
      entryType: EntryType,
      subscriptionId?: string,
      tagIds?: string[]
    ) => {
      // Use provided values or fall back to hook options
      const effectiveEntryType = entryType ?? knownEntryType;
      const effectiveSubscriptionId = subscriptionId ?? knownSubscriptionId;
      const effectiveTagIds = tagIds ?? knownTagIds;

      // Update Zustand synchronously for instant UI feedback
      if (effectiveEntryType) {
        const markFn = read
          ? useRealtimeStore.getState().markRead
          : useRealtimeStore.getState().markUnread;
        for (const id of ids) {
          markFn(id, {
            entryType: effectiveEntryType,
            subscriptionId: effectiveSubscriptionId,
            tagIds: effectiveTagIds,
          });
        }
      }

      // Trigger server mutation
      markReadMutation.mutate({ ids, read });
    },
    [markReadMutation, knownEntryType, knownSubscriptionId, knownTagIds]
  );

  const toggleRead = useCallback(
    (
      entryId: string,
      currentlyRead: boolean,
      entryType: EntryType,
      subscriptionId?: string,
      tagIds?: string[]
    ) => {
      // Use provided values or fall back to hook options
      const effectiveEntryType = entryType ?? knownEntryType;
      const effectiveSubscriptionId = subscriptionId ?? knownSubscriptionId;
      const effectiveTagIds = tagIds ?? knownTagIds;

      // Update Zustand synchronously for instant UI feedback
      if (effectiveEntryType) {
        const markFn = currentlyRead
          ? useRealtimeStore.getState().markUnread
          : useRealtimeStore.getState().markRead;
        markFn(entryId, {
          entryType: effectiveEntryType,
          subscriptionId: effectiveSubscriptionId,
          tagIds: effectiveTagIds,
        });
      }

      // Trigger server mutation
      markReadMutation.mutate({ ids: [entryId], read: !currentlyRead });
    },
    [markReadMutation, knownEntryType, knownSubscriptionId, knownTagIds]
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
