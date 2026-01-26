/**
 * useEntryMutations Hook
 *
 * Provides entry mutations (markRead, star, unstar) with offline-capable queue support.
 * Mutations are queued and synced via the service worker's Background Sync.
 *
 * Uses idempotent timestamps (#401) so offline mutations are properly merged when
 * syncing back online, even if another client made changes in the meantime.
 */

"use client";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { useMutationQueue } from "./useMutationQueue";
import type { EntryContext as MutationQueueEntryContext } from "@/lib/mutation-queue";

/**
 * Entry type for routing.
 */
export type EntryType = "web" | "email" | "saved";

/**
 * Entry context for mutations.
 * Re-exported from mutation-queue for convenience.
 */
export type EntryContext = MutationQueueEntryContext;

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
   * Mark an entry as read or unread.
   * @param entry - Entry context (id, subscriptionId, starred, read, type)
   * @param read - Whether to mark as read (true) or unread (false)
   */
  markRead: (entry: EntryContext, read: boolean) => void;

  /**
   * Toggle the read status of an entry.
   * @param entry - Entry context (id, subscriptionId, starred, read, type)
   */
  toggleRead: (entry: EntryContext) => void;

  /**
   * Mark all entries as read with optional filters.
   */
  markAllRead: (options?: MarkAllReadOptions) => void;

  /**
   * Star an entry.
   * @param entry - Entry context (id, subscriptionId, starred, read, type)
   */
  star: (entry: EntryContext) => void;

  /**
   * Unstar an entry.
   * @param entry - Entry context (id, subscriptionId, starred, read, type)
   */
  unstar: (entry: EntryContext) => void;

  /**
   * Toggle the starred status of an entry.
   * @param entry - Entry context (id, subscriptionId, starred, read, type)
   */
  toggleStar: (entry: EntryContext) => void;

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
 * Hook that provides entry mutations with offline-capable queue support.
 *
 * @example
 * ```tsx
 * function EntryList({ entries }) {
 *   const { toggleRead, toggleStar, isOnline, pendingMutationCount } = useEntryMutations();
 *
 *   return (
 *     <>
 *       {!isOnline && pendingMutationCount > 0 && (
 *         <div>Offline - {pendingMutationCount} changes pending</div>
 *       )}
 *       {entries.map(entry => (
 *         <Entry
 *           key={entry.id}
 *           entry={entry}
 *           onToggleRead={() => toggleRead(entry)}
 *           onToggleStar={() => toggleStar(entry)}
 *         />
 *       ))}
 *     </>
 *   );
 * }
 * ```
 */
export function useEntryMutations(): UseEntryMutationsResult {
  const utils = trpc.useUtils();

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

  // Queue a markRead mutation
  const markRead = useCallback(
    (entry: EntryContext, read: boolean) => {
      queueMarkRead(entry.id, read, entry);
    },
    [queueMarkRead]
  );

  const toggleRead = useCallback(
    (entry: EntryContext) => {
      markRead(entry, !entry.read);
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

  // Queue star mutation
  const star = useCallback(
    (entry: EntryContext) => {
      queueStar(entry.id, entry);
    },
    [queueStar]
  );

  // Queue unstar mutation
  const unstar = useCallback(
    (entry: EntryContext) => {
      queueUnstar(entry.id, entry);
    },
    [queueUnstar]
  );

  const toggleStar = useCallback(
    (entry: EntryContext) => {
      if (entry.starred) {
        unstar(entry);
      } else {
        star(entry);
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
