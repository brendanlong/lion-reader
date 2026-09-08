/**
 * useEntryMutations Hook
 *
 * Entry mutations (markRead, star/unstar, markAllRead). Read/starred updates
 * follow the "optimistic write + timestamp reconciliation" pattern in
 * src/FRONTEND_STATE.md ("Optimistic Updates"): onMutate writes the intended
 * state and registers with the shared EntryMutationTracker, onSuccess records
 * the server state, and onSettled writes the reconciled state once nothing is
 * in flight for the entry. Counts always come from the response.
 */

"use client";

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { setCounts, setBulkCounts } from "@/lib/cache/operations";
import {
  getCachedEntryState,
  updateEntriesReadStatus,
  updateEntryStarredStatus,
  updateEntryState,
} from "@/lib/cache/entry-cache";
import { getEntryMutationTracker, type EntryField } from "@/lib/cache/entry-mutation-tracker";

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
   * Whether the markAllRead mutation is pending.
   */
  isMarkAllReadPending: boolean;
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
  const tracker = getEntryMutationTracker(queryClient);

  const startTracking = (entryId: string, field: EntryField) => {
    tracker.start(entryId, field, getCachedEntryState(utils, queryClient, entryId));
  };

  /**
   * Settles one mutation for the entry and, when it was the last in flight,
   * writes the reconciled state to entries.get and every entry list together.
   * The lists go through the same guard as entries.get: writing them
   * unconditionally from each response lets two rapid conflicting mutations
   * that complete out of order leave the list at the older state.
   *
   * Never throws: a throw inside onSettled makes React Query run onError and
   * onSettled again for a mutation that succeeded, and would leave the other
   * entries of a markRead batch unsettled in the shared tracker.
   */
  const settleEntry = (entryId: string) => {
    let settlement;
    try {
      settlement = tracker.settle(entryId);
    } catch (error) {
      console.error("entry mutation settle error:", error);
      return;
    }
    if (!settlement) return;

    if (settlement.kind === "apply") {
      const cachedUpdatedAt = utils.entries.get.getData({ id: entryId })?.entry?.updatedAt;
      if (cachedUpdatedAt && settlement.state.updatedAt.getTime() < cachedUpdatedAt.getTime()) {
        return;
      }
      updateEntryState(utils, queryClient, entryId, settlement.state);
    } else if (settlement.state) {
      updateEntryState(utils, queryClient, entryId, settlement.state);
    }
  };

  const markReadMutation = trpc.entries.markRead.useMutation({
    onMutate: (variables) => {
      const entryIds = variables.entries.map((e) => e.id);
      for (const entryId of entryIds) {
        startTracking(entryId, "read");
      }
      updateEntriesReadStatus(utils, entryIds, variables.read, queryClient);
    },

    onSuccess: (data) => {
      for (const entry of data.entries) {
        tracker.recordSuccess(entry.id, {
          read: entry.read,
          starred: entry.starred,
          updatedAt: entry.updatedAt,
        });
      }
      if (data.counts) {
        setBulkCounts(utils, data.counts, queryClient);
      }
    },

    onError: (error) => {
      console.error("markRead mutation error:", error);
      toast.error("Failed to update read status");
    },

    onSettled: (_data, _error, variables) => {
      for (const entry of variables.entries) {
        settleEntry(entry.id);
      }
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

  const setStarredMutation = trpc.entries.setStarred.useMutation({
    onMutate: (variables) => {
      startTracking(variables.id, "starred");
      updateEntryStarredStatus(utils, variables.id, variables.starred, queryClient);
    },

    onSuccess: (data) => {
      tracker.recordSuccess(data.entry.id, {
        read: data.entry.read,
        starred: data.entry.starred,
        updatedAt: data.entry.updatedAt,
      });
      if (data.counts) {
        setCounts(utils, data.counts, queryClient);
      }
    },

    onError: (error, variables) => {
      console.error("setStarred mutation error:", error);
      toast.error(variables.starred ? "Failed to star entry" : "Failed to unstar entry");
    },

    onSettled: (_data, _error, variables) => {
      settleEntry(variables.id);
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

  return useMemo(
    () => ({
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      isMarkAllReadPending: markAllReadMutation.isPending,
    }),
    [markRead, toggleRead, markAllRead, star, unstar, toggleStar, markAllReadMutation.isPending]
  );
}
