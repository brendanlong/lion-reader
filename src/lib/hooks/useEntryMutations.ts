/**
 * useEntryMutations Hook
 *
 * Provides entry mutations (markRead, star, unstar, setScore) with optimistic updates.
 * Consolidates mutation logic from page components.
 *
 * Uses optimistic updates for immediate UI feedback:
 * - Read/starred status updates appear instantly in the UI
 * - If the server request fails, changes are rolled back automatically
 * - Server response is used to update counts and scores after success
 *
 * Uses high-level cache operations that handle all interactions correctly
 * (e.g., starring an unread entry updates the starred unread count).
 */

"use client";

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import {
  handleEntryScoreChanged,
  setCounts,
  setBulkCounts,
  updateEntriesReadStatus,
  updateEntryStarredStatus,
  updateEntriesInAffectedListCaches,
  applyOptimisticReadUpdate,
  rollbackOptimisticReadUpdate,
  applyOptimisticStarredUpdate,
  rollbackOptimisticStarredUpdate,
} from "@/lib/cache";

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
   * @param fromList - If true, sets implicit score signal (mark-read-on-list)
   */
  markRead: (ids: string[], read: boolean, fromList?: boolean) => void;

  /**
   * Toggle the read status of an entry.
   * @param fromList - If true, sets implicit score signal (mark-read-on-list)
   */
  toggleRead: (entryId: string, currentlyRead: boolean, fromList?: boolean) => void;

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
   * Set the explicit score for an entry (-2 to +2, or null to clear).
   */
  setScore: (entryId: string, score: number | null) => void;

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

  // markRead mutation - uses optimistic updates for instant UI feedback
  // Also updates score cache since marking read/unread sets implicit signal flags
  const markReadMutation = trpc.entries.markRead.useMutation({
    // Optimistic update: immediately update the UI before server responds
    onMutate: async (variables) => {
      const entryIds = variables.entries.map((e) => e.id);
      return applyOptimisticReadUpdate(utils, queryClient, entryIds, variables.read);
    },

    onSuccess: (data, variables) => {
      // Server confirmed - update with authoritative data
      // The read status is already updated optimistically, but we need to:
      // 1. Update individual entries.get caches with any additional data
      updateEntriesReadStatus(
        utils,
        data.entries.map((e) => e.id),
        variables.read
      );

      // 2. Update only the affected entry list caches using server-provided scope
      const scope = {
        tagIds: new Set(data.counts.tags.map((t) => t.id)),
        hasUncategorized: data.counts.uncategorized !== undefined,
      };
      updateEntriesInAffectedListCaches(queryClient, data.entries, { read: variables.read }, scope);

      // 3. Set absolute counts from server (no delta calculations)
      setBulkCounts(utils, data.counts, queryClient);

      // 4. Update score cache for each entry (implicit signals changed)
      for (const entry of data.entries) {
        handleEntryScoreChanged(utils, entry.id, entry.score, entry.implicitScore, queryClient);
      }
    },

    onError: (_error, _variables, context) => {
      // Rollback to previous state on error
      if (context) {
        rollbackOptimisticReadUpdate(utils, queryClient, context);
      }
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

  // setStarred mutation - uses optimistic updates for instant UI feedback
  // Also updates score cache since starring sets hasStarred implicit signal
  const setStarredMutation = trpc.entries.setStarred.useMutation({
    // Optimistic update: immediately show the entry with new starred status
    onMutate: async (variables) => {
      return applyOptimisticStarredUpdate(utils, queryClient, variables.id, variables.starred);
    },

    onSuccess: (data) => {
      // Server confirmed - update with authoritative data
      updateEntryStarredStatus(utils, data.entry.id, data.entry.starred, queryClient);

      // Set absolute counts from server
      setCounts(utils, data.counts, queryClient);

      handleEntryScoreChanged(
        utils,
        data.entry.id,
        data.entry.score,
        data.entry.implicitScore,
        queryClient
      );
    },

    onError: (_error, variables, context) => {
      // Rollback to previous state on error
      if (context) {
        rollbackOptimisticStarredUpdate(utils, queryClient, context);
      }
      toast.error(variables.starred ? "Failed to star entry" : "Failed to unstar entry");
    },
  });

  // setScore mutation - updates score cache only (no count changes)
  const setScoreMutation = trpc.entries.setScore.useMutation({
    onSuccess: (data) => {
      handleEntryScoreChanged(
        utils,
        data.entry.id,
        data.entry.score,
        data.entry.implicitScore,
        queryClient
      );
    },
    onError: () => {
      toast.error("Failed to update score");
    },
  });

  // Generate timestamp at action time for idempotent updates
  const markRead = useCallback(
    (ids: string[], read: boolean, fromList?: boolean) => {
      const changedAt = new Date();
      markReadMutation.mutate({
        entries: ids.map((id) => ({ id, changedAt })),
        read,
        fromList: fromList || undefined,
      });
    },
    [markReadMutation]
  );

  const toggleRead = useCallback(
    (entryId: string, currentlyRead: boolean, fromList?: boolean) => {
      markReadMutation.mutate({
        entries: [{ id: entryId, changedAt: new Date() }],
        read: !currentlyRead,
        fromList: fromList || undefined,
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
      setStarredMutation.mutate({ id: entryId, starred: true, changedAt: new Date() });
    },
    [setStarredMutation]
  );

  const unstar = useCallback(
    (entryId: string) => {
      setStarredMutation.mutate({ id: entryId, starred: false, changedAt: new Date() });
    },
    [setStarredMutation]
  );

  const toggleStar = useCallback(
    (entryId: string, currentlyStarred: boolean) => {
      setStarredMutation.mutate({
        id: entryId,
        starred: !currentlyStarred,
        changedAt: new Date(),
      });
    },
    [setStarredMutation]
  );

  const setScore = useCallback(
    (entryId: string, score: number | null) => {
      setScoreMutation.mutate({ id: entryId, score, changedAt: new Date() });
    },
    [setScoreMutation]
  );

  const isPending =
    markReadMutation.isPending ||
    markAllReadMutation.isPending ||
    setStarredMutation.isPending ||
    setScoreMutation.isPending;

  return useMemo(
    () => ({
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      setScore,
      isPending,
      isMarkReadPending: markReadMutation.isPending,
      isMarkAllReadPending: markAllReadMutation.isPending,
      isStarPending: setStarredMutation.isPending,
    }),
    [
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      setScore,
      isPending,
      markReadMutation.isPending,
      markAllReadMutation.isPending,
      setStarredMutation.isPending,
    ]
  );
}
