/**
 * useEntryMutations Hook
 *
 * Provides entry mutations (markRead, star, unstar) with direct cache updates.
 * Consolidates mutation logic from page components.
 *
 * Uses high-level cache operations that handle all interactions correctly
 * (e.g., starring an unread entry updates the starred unread count).
 */

"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { handleEntriesMarkedRead, handleEntryStarred, handleEntryUnstarred } from "@/lib/cache";

/**
 * Entry type for routing.
 */
export type EntryType = "web" | "email" | "saved";

/**
 * Options for the markAllRead mutation.
 */
export interface MarkAllReadOptions {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
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
 * Hook that provides entry mutations with direct cache updates.
 *
 * @example
 * ```tsx
 * function EntryList() {
 *   const { toggleRead, toggleStar } = useEntryMutations();
 *
 *   return (
 *     <Entry
 *       onToggleRead={(id, read) => toggleRead(id, read)}
 *       onToggleStar={(id, starred) => toggleStar(id, starred)}
 *     />
 *   );
 * }
 * ```
 */
export function useEntryMutations(): UseEntryMutationsResult {
  const utils = trpc.useUtils();

  // markRead mutation - uses handleEntriesMarkedRead for all cache updates
  const markReadMutation = trpc.entries.markRead.useMutation({
    onSuccess: (data, variables) => {
      handleEntriesMarkedRead(utils, data.entries, variables.read);
    },
    onError: () => {
      toast.error("Failed to update read status");
    },
  });

  // markAllRead mutation - invalidates all caches (unknown which entries affected)
  const markAllReadMutation = trpc.entries.markAllRead.useMutation({
    onSuccess: () => {
      utils.entries.list.invalidate();
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      utils.entries.count.invalidate({ starredOnly: true });
    },
    onError: () => {
      toast.error("Failed to mark all as read");
    },
  });

  // star mutation - uses handleEntryStarred for all cache updates
  const starMutation = trpc.entries.star.useMutation({
    onSuccess: (data) => {
      handleEntryStarred(utils, data.entry.id, data.entry.read);
    },
    onError: () => {
      toast.error("Failed to star entry");
    },
  });

  // unstar mutation - uses handleEntryUnstarred for all cache updates
  const unstarMutation = trpc.entries.unstar.useMutation({
    onSuccess: (data) => {
      handleEntryUnstarred(utils, data.entry.id, data.entry.read);
    },
    onError: () => {
      toast.error("Failed to unstar entry");
    },
  });

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

  return useMemo(
    () => ({
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      isPending,
      isMarkReadPending: markReadMutation.isPending,
      isMarkAllReadPending: markAllReadMutation.isPending,
      isStarPending: starMutation.isPending || unstarMutation.isPending,
    }),
    [
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      isPending,
      markReadMutation.isPending,
      markAllReadMutation.isPending,
      starMutation.isPending,
      unstarMutation.isPending,
    ]
  );
}
