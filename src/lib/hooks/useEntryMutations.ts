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
import { useQueryClient } from "@tanstack/react-query";
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
  type?: EntryType;
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
  const queryClient = useQueryClient();

  // markRead mutation - uses handleEntriesMarkedRead for all cache updates
  const markReadMutation = trpc.entries.markRead.useMutation({
    onSuccess: (data, variables) => {
      handleEntriesMarkedRead(utils, data.entries, variables.read, queryClient);
    },
    onError: () => {
      toast.error("Failed to update read status");
    },
  });

  // markAllRead mutation - invalidates caches based on what could be affected
  const markAllReadMutation = trpc.entries.markAllRead.useMutation({
    onSuccess: (_data, variables) => {
      utils.entries.list.invalidate();
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();

      // All Articles count is always affected
      utils.entries.count.invalidate({});

      // Starred count is always affected since starred entries can exist in any view
      utils.entries.count.invalidate({ starredOnly: true });

      // Invalidate saved count if saved entries could be affected
      // (either type: "saved" was set, or no type filter means all including saved)
      if (variables.type === "saved" || !variables.type) {
        utils.entries.count.invalidate({ type: "saved" });
      }
    },
    onError: () => {
      toast.error("Failed to mark all as read");
    },
  });

  // star mutation - uses handleEntryStarred for all cache updates
  const starMutation = trpc.entries.star.useMutation({
    onSuccess: (data) => {
      handleEntryStarred(utils, data.entry.id, data.entry.read, queryClient);
    },
    onError: () => {
      toast.error("Failed to star entry");
    },
  });

  // unstar mutation - uses handleEntryUnstarred for all cache updates
  const unstarMutation = trpc.entries.unstar.useMutation({
    onSuccess: (data) => {
      handleEntryUnstarred(utils, data.entry.id, data.entry.read, queryClient);
    },
    onError: () => {
      toast.error("Failed to unstar entry");
    },
  });

  // Generate timestamp at action time for idempotent updates
  const markRead = useCallback(
    (ids: string[], read: boolean) => {
      const changedAt = new Date();
      markReadMutation.mutate({
        entries: ids.map((id) => ({ id, changedAt })),
        read,
      });
    },
    [markReadMutation]
  );

  const toggleRead = useCallback(
    (entryId: string, currentlyRead: boolean) => {
      markReadMutation.mutate({
        entries: [{ id: entryId, changedAt: new Date() }],
        read: !currentlyRead,
      });
    },
    [markReadMutation]
  );

  const markAllRead = useCallback(
    (options?: MarkAllReadOptions) => {
      markAllReadMutation.mutate({ ...options, changedAt: new Date() });
    },
    [markAllReadMutation]
  );

  const star = useCallback(
    (entryId: string) => {
      starMutation.mutate({ id: entryId, changedAt: new Date() });
    },
    [starMutation]
  );

  const unstar = useCallback(
    (entryId: string) => {
      unstarMutation.mutate({ id: entryId, changedAt: new Date() });
    },
    [unstarMutation]
  );

  const toggleStar = useCallback(
    (entryId: string, currentlyStarred: boolean) => {
      const changedAt = new Date();
      if (currentlyStarred) {
        unstarMutation.mutate({ id: entryId, changedAt });
      } else {
        starMutation.mutate({ id: entryId, changedAt });
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
