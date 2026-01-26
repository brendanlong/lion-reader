/**
 * useEntryMutations Hook
 *
 * Provides entry mutations (markRead, star, unstar) with offline-capable queue support.
 * Mutations are queued in IndexedDB and synced when online, with optimistic UI updates.
 *
 * Uses idempotent timestamps (#401) so offline mutations are properly merged when
 * syncing back online, even if another client made changes in the meantime.
 */

"use client";

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { findEntryInListCache, type EntryWithContext } from "@/lib/cache";
import { useMutationQueue } from "./useMutationQueue";

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

  /**
   * Whether we're currently online.
   */
  isOnline: boolean;

  /**
   * Number of pending mutations in the offline queue.
   */
  pendingMutationCount: number;
}

/**
 * Look up entry context from the React Query cache.
 * Tries entries.get cache first, then entries.list cache.
 */
function getEntryContextFromCache(
  utils: ReturnType<typeof trpc.useUtils>,
  queryClient: ReturnType<typeof useQueryClient>,
  entryId: string
): EntryWithContext | null {
  // Try entries.get cache first (full entry data)
  const entryData = utils.entries.get.getData({ id: entryId });
  if (entryData?.entry) {
    return {
      id: entryData.entry.id,
      subscriptionId: entryData.entry.subscriptionId,
      starred: entryData.entry.starred,
      type: entryData.entry.type,
    };
  }

  // Fall back to entries.list cache
  const listEntry = findEntryInListCache(queryClient, entryId);
  if (listEntry) {
    return {
      id: listEntry.id,
      subscriptionId: listEntry.subscriptionId,
      starred: listEntry.starred,
      type: listEntry.type,
    };
  }

  return null;
}

/**
 * Hook that provides entry mutations with offline-capable queue support.
 *
 * @example
 * ```tsx
 * function EntryList() {
 *   const { toggleRead, toggleStar, isOnline, pendingMutationCount } = useEntryMutations();
 *
 *   return (
 *     <>
 *       {!isOnline && pendingMutationCount > 0 && (
 *         <div>Offline - {pendingMutationCount} changes pending</div>
 *       )}
 *       <Entry
 *         onToggleRead={(id, read) => toggleRead(id, read)}
 *         onToggleStar={(id, starred) => toggleStar(id, starred)}
 *       />
 *     </>
 *   );
 * }
 * ```
 */
export function useEntryMutations(): UseEntryMutationsResult {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Mutation queue for offline support
  const {
    queueMarkRead,
    queueStar,
    queueUnstar,
    isOnline,
    pendingCount: pendingMutationCount,
    isSyncing,
  } = useMutationQueue();

  // markAllRead mutation - uses direct tRPC (not queued, requires online)
  // This is intentional: marking all read is a bulk operation that's less common
  // and harder to handle correctly offline (what if new entries arrive?)
  const markAllReadMutation = trpc.entries.markAllRead.useMutation({
    onSuccess: (_data, variables) => {
      utils.entries.list.invalidate();
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();

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

  // Queue a markRead mutation with entry context lookup
  const markRead = useCallback(
    (ids: string[], read: boolean) => {
      for (const entryId of ids) {
        const context = getEntryContextFromCache(utils, queryClient, entryId);
        if (context) {
          queueMarkRead(entryId, read, context);
        } else {
          // Entry not in cache - this shouldn't happen in normal usage
          // but if it does, create a minimal context
          console.warn(`Entry ${entryId} not found in cache for markRead`);
          queueMarkRead(entryId, read, {
            id: entryId,
            subscriptionId: null,
            starred: false,
            type: "web",
          });
        }
      }
    },
    [utils, queryClient, queueMarkRead]
  );

  const toggleRead = useCallback(
    (entryId: string, currentlyRead: boolean) => {
      markRead([entryId], !currentlyRead);
    },
    [markRead]
  );

  const markAllRead = useCallback(
    (options?: MarkAllReadOptions) => {
      if (!isOnline) {
        toast.error("Cannot mark all as read while offline");
        return;
      }
      markAllReadMutation.mutate({ ...options, changedAt: new Date() });
    },
    [markAllReadMutation, isOnline]
  );

  // Queue star mutation with entry context lookup
  const star = useCallback(
    (entryId: string) => {
      const context = getEntryContextFromCache(utils, queryClient, entryId);
      if (context) {
        queueStar(entryId, context);
      } else {
        console.warn(`Entry ${entryId} not found in cache for star`);
        queueStar(entryId, {
          id: entryId,
          subscriptionId: null,
          starred: false,
          type: "web",
        });
      }
    },
    [utils, queryClient, queueStar]
  );

  // Queue unstar mutation with entry context lookup
  const unstar = useCallback(
    (entryId: string) => {
      const context = getEntryContextFromCache(utils, queryClient, entryId);
      if (context) {
        queueUnstar(entryId, context);
      } else {
        console.warn(`Entry ${entryId} not found in cache for unstar`);
        queueUnstar(entryId, {
          id: entryId,
          subscriptionId: null,
          starred: true,
          type: "web",
        });
      }
    },
    [utils, queryClient, queueUnstar]
  );

  const toggleStar = useCallback(
    (entryId: string, currentlyStarred: boolean) => {
      if (currentlyStarred) {
        unstar(entryId);
      } else {
        star(entryId);
      }
    },
    [star, unstar]
  );

  // isPending reflects both local pending state and sync state
  const isPending = markAllReadMutation.isPending || isSyncing;

  return useMemo(
    () => ({
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      isPending,
      isMarkReadPending: isSyncing,
      isMarkAllReadPending: markAllReadMutation.isPending,
      isStarPending: isSyncing,
      isOnline,
      pendingMutationCount,
    }),
    [
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      isPending,
      isSyncing,
      markAllReadMutation.isPending,
      isOnline,
      pendingMutationCount,
    ]
  );
}
