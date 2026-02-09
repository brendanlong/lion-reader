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
 * Tracks pending mutations per entry with timestamp-based state merging:
 * - Multiple mutations can run in parallel for the same entry
 * - Each mutation's response is compared by updatedAt timestamp
 * - The "winning" state (newest updatedAt) is tracked
 * - When all mutations complete, the winning state is merged into cache
 *   only if it's newer than the current cache state
 */

"use client";

import { useCallback, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useCollections } from "@/lib/collections/context";
import { setCounts, setBulkCounts } from "@/lib/cache/operations";
import {
  updateEntryReadInCollection,
  updateEntryStarredInCollection,
  updateEntryScoreInCollection,
} from "@/lib/collections/writes";

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
 * State from a completed mutation, tracked for timestamp-based merging.
 */
interface MutationResultState {
  read: boolean;
  starred: boolean;
  updatedAt: Date;
  score: number | null;
  implicitScore: number;
}

/**
 * Tracking state for an entry with pending mutations.
 */
interface EntryMutationTracking {
  /** Number of mutations currently in flight */
  pendingCount: number;
  /** The winning state from completed mutations (newest updatedAt) */
  winningState: MutationResultState | null;
  /** Original state for rollback if all mutations fail */
  originalRead: boolean;
  originalStarred: boolean;
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
  const collections = useCollections();

  // Track pending mutations per entry for timestamp-based state merging
  const entryTracking = useRef(new Map<string, EntryMutationTracking>());

  /**
   * Start tracking a mutation for an entry.
   * Increments pending count and stores original state if this is the first mutation.
   */
  const startTracking = (entryId: string, originalRead: boolean, originalStarred: boolean) => {
    const existing = entryTracking.current.get(entryId);
    if (existing) {
      existing.pendingCount++;
    } else {
      entryTracking.current.set(entryId, {
        pendingCount: 1,
        winningState: null,
        originalRead,
        originalStarred,
      });
    }
  };

  /**
   * Record a mutation result and determine if we should update cache.
   * Compares updatedAt with tracked winning state, keeps the newer one.
   * Returns true if all mutations for this entry are now complete.
   */
  const recordMutationResult = (
    entryId: string,
    result: MutationResultState
  ): { allComplete: boolean; winningState: MutationResultState | null } => {
    const tracking = entryTracking.current.get(entryId);
    if (!tracking) {
      // No tracking = single mutation, just return it as winner
      return { allComplete: true, winningState: result };
    }

    // Compare with current winning state
    if (
      !tracking.winningState ||
      result.updatedAt.getTime() >= tracking.winningState.updatedAt.getTime()
    ) {
      tracking.winningState = result;
    }

    tracking.pendingCount--;
    const allComplete = tracking.pendingCount === 0;

    if (allComplete) {
      const winner = tracking.winningState;
      entryTracking.current.delete(entryId);
      return { allComplete: true, winningState: winner };
    }

    return { allComplete: false, winningState: null };
  };

  /**
   * Record a mutation error. Returns rollback info if all mutations are complete.
   */
  const recordMutationError = (
    entryId: string
  ): {
    allComplete: boolean;
    winningState: MutationResultState | null;
    originalRead: boolean;
    originalStarred: boolean;
  } | null => {
    const tracking = entryTracking.current.get(entryId);
    if (!tracking) return null;

    tracking.pendingCount--;
    const allComplete = tracking.pendingCount === 0;

    if (allComplete) {
      const result = {
        allComplete: true,
        winningState: tracking.winningState,
        originalRead: tracking.originalRead,
        originalStarred: tracking.originalStarred,
      };
      entryTracking.current.delete(entryId);
      return result;
    }

    return { allComplete: false, winningState: null, originalRead: false, originalStarred: false };
  };

  /**
   * Apply winning state to cache if it's newer than current cache state.
   * Updates entries.get (detail view) and collection (list view).
   */
  const applyWinningStateToCache = (entryId: string, winningState: MutationResultState) => {
    // Get current cache state to compare timestamps
    const cachedData = utils.entries.get.getData({ id: entryId });
    const cachedUpdatedAt = cachedData?.entry?.updatedAt;

    // Only update if winning state is newer than cache
    if (cachedUpdatedAt && winningState.updatedAt.getTime() < cachedUpdatedAt.getTime()) {
      // Cache is newer, don't update
      return;
    }

    // Update entries.get cache (detail view)
    utils.entries.get.setData({ id: entryId }, (oldData) => {
      if (!oldData) return oldData;
      return {
        ...oldData,
        entry: {
          ...oldData.entry,
          read: winningState.read,
          starred: winningState.starred,
          score: winningState.score,
          implicitScore: winningState.implicitScore,
        },
      };
    });

    // Update entries collection (list view, via reactive useLiveQuery)
    updateEntryReadInCollection(collections, [entryId], winningState.read);
    updateEntryStarredInCollection(collections, entryId, winningState.starred);
    updateEntryScoreInCollection(
      collections,
      entryId,
      winningState.score,
      winningState.implicitScore
    );
  };

  // markRead mutation - uses optimistic updates for instant UI feedback
  // Also updates score cache since marking read/unread sets implicit signal flags
  const markReadMutation = trpc.entries.markRead.useMutation({
    // Optimistic update: immediately update the UI before server responds
    onMutate: async (variables) => {
      const entryIds = variables.entries.map((e) => e.id);

      // Snapshot previous state for rollback
      const previousEntries = new Map<string, { read: boolean } | undefined>();
      for (const entryId of entryIds) {
        const data = utils.entries.get.getData({ id: entryId });
        previousEntries.set(entryId, data?.entry ? { read: data.entry.read } : undefined);
      }

      // Optimistically update entries.get cache (detail view)
      for (const entryId of entryIds) {
        utils.entries.get.setData({ id: entryId }, (oldData) => {
          if (!oldData) return oldData;
          return { ...oldData, entry: { ...oldData.entry, read: variables.read } };
        });
      }

      // Optimistic update in entries collection (list view, via reactive useLiveQuery)
      updateEntryReadInCollection(collections, entryIds, variables.read);

      // Start tracking for each entry
      for (const entryId of entryIds) {
        const prevEntry = previousEntries.get(entryId);
        const originalRead = prevEntry?.read ?? false;
        const cachedData = utils.entries.get.getData({ id: entryId });
        const originalStarred = cachedData?.entry?.starred ?? false;
        startTracking(entryId, originalRead, originalStarred);
      }

      return { previousEntries, entryIds };
    },

    onSuccess: (data) => {
      // Process each entry's result
      for (const entry of data.entries) {
        const result: MutationResultState = {
          read: entry.read,
          starred: entry.starred,
          updatedAt: entry.updatedAt,
          score: entry.score,
          implicitScore: entry.implicitScore,
        };

        const { allComplete, winningState } = recordMutationResult(entry.id, result);

        if (allComplete && winningState) {
          applyWinningStateToCache(entry.id, winningState);
        }
      }

      // Update entries in collection with server state (read + score)
      for (const entry of data.entries) {
        updateEntryReadInCollection(collections, [entry.id], entry.read);
        updateEntryScoreInCollection(collections, entry.id, entry.score, entry.implicitScore);
      }

      // Update counts (always apply, not dependent on timestamp)
      setBulkCounts(utils, data.counts, queryClient, collections);
    },

    onError: (error, variables) => {
      console.error("markRead mutation error:", error);
      const entryIds = variables.entries.map((e) => e.id);

      // Check each entry for completion and handle rollback
      for (const entryId of entryIds) {
        const result = recordMutationError(entryId);
        if (result?.allComplete) {
          if (result.winningState) {
            // Some mutations succeeded, apply winning state
            applyWinningStateToCache(entryId, result.winningState);
          } else {
            // All mutations failed, rollback to original state
            utils.entries.get.setData({ id: entryId }, (oldData) => {
              if (!oldData) return oldData;
              return { ...oldData, entry: { ...oldData.entry, read: result.originalRead } };
            });
            updateEntryReadInCollection(collections, [entryId], result.originalRead);
          }
        }
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
      // Snapshot previous state for rollback
      const previousEntry = utils.entries.get.getData({ id: variables.id });
      const wasStarred = previousEntry?.entry?.starred ?? !variables.starred;

      // Optimistically update entries.get cache (detail view)
      utils.entries.get.setData({ id: variables.id }, (oldData) => {
        if (!oldData) return oldData;
        return { ...oldData, entry: { ...oldData.entry, starred: variables.starred } };
      });

      // Optimistic update in entries collection (list view, via reactive useLiveQuery)
      updateEntryStarredInCollection(collections, variables.id, variables.starred);

      // Start tracking
      const originalStarred = wasStarred;
      const cachedData = utils.entries.get.getData({ id: variables.id });
      const originalRead = cachedData?.entry?.read ?? false;
      startTracking(variables.id, originalRead, originalStarred);

      return { entryId: variables.id, wasStarred };
    },

    onSuccess: (data) => {
      const result: MutationResultState = {
        read: data.entry.read,
        starred: data.entry.starred,
        updatedAt: data.entry.updatedAt,
        score: data.entry.score,
        implicitScore: data.entry.implicitScore,
      };

      const { allComplete, winningState } = recordMutationResult(data.entry.id, result);

      if (allComplete && winningState) {
        applyWinningStateToCache(data.entry.id, winningState);
      }

      // Update entries collection with server state (starred + score)
      updateEntryStarredInCollection(collections, data.entry.id, data.entry.starred);
      updateEntryScoreInCollection(
        collections,
        data.entry.id,
        data.entry.score,
        data.entry.implicitScore
      );

      // Update counts (always apply)
      setCounts(utils, data.counts, queryClient, collections);
    },

    onError: (error, variables) => {
      console.error("setStarred mutation error:", error);
      const result = recordMutationError(variables.id);
      if (result?.allComplete) {
        if (result.winningState) {
          applyWinningStateToCache(variables.id, result.winningState);
        } else {
          // All mutations failed, rollback to original state
          utils.entries.get.setData({ id: variables.id }, (oldData) => {
            if (!oldData) return oldData;
            return { ...oldData, entry: { ...oldData.entry, starred: result.originalStarred } };
          });
          updateEntryStarredInCollection(collections, variables.id, result.originalStarred);
        }
      }
      toast.error(variables.starred ? "Failed to star entry" : "Failed to unstar entry");
    },
  });

  // setScore mutation - updates score cache only (no count changes)
  const setScoreMutation = trpc.entries.setScore.useMutation({
    onSuccess: (data) => {
      // Update entries.get cache (detail view)
      utils.entries.get.setData({ id: data.entry.id }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          entry: {
            ...oldData.entry,
            score: data.entry.score,
            implicitScore: data.entry.implicitScore,
          },
        };
      });

      // Update entries collection (list view)
      updateEntryScoreInCollection(
        collections,
        data.entry.id,
        data.entry.score,
        data.entry.implicitScore
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
