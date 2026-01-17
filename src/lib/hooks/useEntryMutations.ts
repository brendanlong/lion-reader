/**
 * useEntryMutations Hook
 *
 * Provides entry mutations (markRead, star, unstar) with cache invalidation.
 * Consolidates mutation logic from page components.
 */

"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";

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
 * Hook that provides entry mutations with cache invalidation.
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

  // markRead mutation - invalidate on success
  const markReadMutation = trpc.entries.markRead.useMutation({
    onSuccess: () => {
      // Invalidate entry lists and counts
      utils.entries.list.invalidate();
      utils.entries.count.invalidate();
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
    },
    onError: () => {
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

  // star mutation - invalidate on success
  const starMutation = trpc.entries.star.useMutation({
    onSuccess: () => {
      // Invalidate starred entries list and count
      utils.entries.list.invalidate({ starredOnly: true });
      utils.entries.count.invalidate({ starredOnly: true });
    },
    onError: () => {
      toast.error("Failed to star entry");
    },
  });

  // unstar mutation - invalidate on success
  const unstarMutation = trpc.entries.unstar.useMutation({
    onSuccess: () => {
      // Invalidate starred entries list and count
      utils.entries.list.invalidate({ starredOnly: true });
      utils.entries.count.invalidate({ starredOnly: true });
    },
    onError: () => {
      toast.error("Failed to unstar entry");
    },
  });

  // Note: entryType, subscriptionId, tagIds are kept in signature for API
  // compatibility but are unused since we removed Zustand delta tracking.
  // Callers may still pass them; we just ignore them.
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
