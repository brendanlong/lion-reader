/**
 * useMutationQueue Hook
 *
 * Manages the offline-capable mutation queue for read/starred operations.
 * Provides functions to queue mutations and automatically syncs them when online.
 *
 * Features:
 * - Stores mutations in IndexedDB for offline persistence
 * - Uses idempotent timestamps from #401 for conflict resolution
 * - Automatically syncs when coming back online
 * - Provides optimistic UI state based on queued mutations
 * - Retries failed mutations with exponential backoff
 */

"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  MutationQueueStore,
  MAX_RETRIES,
  type QueuedMutation,
  type MutationType,
  type EntryContext,
} from "@/lib/mutation-queue";
import { handleEntriesMarkedRead, handleEntryStarred, handleEntryUnstarred } from "@/lib/cache";

/**
 * Backoff delays for retries (in ms).
 * Exponential: 1s, 2s, 4s, 8s, 16s
 */
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 16000];

/**
 * Result of the useMutationQueue hook.
 */
export interface UseMutationQueueResult {
  /**
   * Whether the queue is initialized and ready.
   */
  isReady: boolean;

  /**
   * Whether we're currently online.
   */
  isOnline: boolean;

  /**
   * Number of pending mutations in the queue.
   */
  pendingCount: number;

  /**
   * Whether we're currently syncing the queue.
   */
  isSyncing: boolean;

  /**
   * Queue a mark read/unread mutation.
   */
  queueMarkRead: (entryId: string, read: boolean, entryContext: EntryContext) => Promise<void>;

  /**
   * Queue a star mutation.
   */
  queueStar: (entryId: string, entryContext: EntryContext) => Promise<void>;

  /**
   * Queue an unstar mutation.
   */
  queueUnstar: (entryId: string, entryContext: EntryContext) => Promise<void>;

  /**
   * Get the latest queued state for an entry (for optimistic UI).
   * Returns undefined if no queued mutations for this entry.
   */
  getQueuedState: (entryId: string) => { read?: boolean; starred?: boolean } | undefined;

  /**
   * Force a sync attempt (useful after coming online).
   */
  syncNow: () => Promise<void>;
}

/**
 * Hook that manages the offline-capable mutation queue.
 *
 * @example
 * ```tsx
 * function EntryItem({ entry }) {
 *   const { queueMarkRead, queueStar, isOnline } = useMutationQueue();
 *
 *   const handleToggleRead = () => {
 *     queueMarkRead(entry.id, !entry.read, {
 *       id: entry.id,
 *       subscriptionId: entry.subscriptionId,
 *       starred: entry.starred,
 *       type: entry.type,
 *     });
 *   };
 *
 *   return (
 *     <button onClick={handleToggleRead}>
 *       {entry.read ? "Mark Unread" : "Mark Read"}
 *       {!isOnline && " (offline)"}
 *     </button>
 *   );
 * }
 * ```
 */
export function useMutationQueue(): UseMutationQueueResult {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Store instance (lazy init)
  const storeRef = useRef<MutationQueueStore | null>(null);

  // State
  const [isReady, setIsReady] = useState(false);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  // Track queued states for optimistic UI (in-memory cache)
  const queuedStatesRef = useRef<Map<string, { read?: boolean; starred?: boolean }>>(new Map());

  // Sync lock to prevent concurrent syncs
  const syncLockRef = useRef(false);

  // tRPC mutation for markRead
  const markReadMutation = trpc.entries.markRead.useMutation();
  const starMutation = trpc.entries.star.useMutation();
  const unstarMutation = trpc.entries.unstar.useMutation();

  // Initialize store
  useEffect(() => {
    if (!MutationQueueStore.isAvailable()) {
      // IndexedDB not available, mark as ready anyway (will use direct mutations)
      setIsReady(true);
      return;
    }

    const store = new MutationQueueStore();
    storeRef.current = store;

    // Load initial pending count and build in-memory cache
    const init = async () => {
      try {
        const pending = await store.getPending();
        setPendingCount(pending.length);

        // Build in-memory state cache
        const states = new Map<string, { read?: boolean; starred?: boolean }>();
        for (const mutation of pending) {
          const existing = states.get(mutation.entryId) ?? {};
          if (mutation.type === "markRead") {
            existing.read = mutation.read;
          } else if (mutation.type === "star") {
            existing.starred = true;
          } else if (mutation.type === "unstar") {
            existing.starred = false;
          }
          states.set(mutation.entryId, existing);
        }
        queuedStatesRef.current = states;

        setIsReady(true);
      } catch (error) {
        console.error("Failed to initialize mutation queue:", error);
        setIsReady(true); // Still mark ready, will fall back to direct mutations
      }
    };

    init();

    return () => {
      store.close();
    };
  }, []);

  // Online/offline detection
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  // Process a single mutation
  const processMutation = useCallback(
    async (mutation: QueuedMutation): Promise<boolean> => {
      const store = storeRef.current;
      if (!store) return false;

      try {
        // Mark as processing
        await store.update({ ...mutation, status: "processing" });

        if (mutation.type === "markRead") {
          const result = await markReadMutation.mutateAsync({
            entries: [{ id: mutation.entryId, changedAt: mutation.changedAt }],
            read: mutation.read!,
          });

          // Update cache with server response
          handleEntriesMarkedRead(utils, result.entries, mutation.read!, queryClient);
        } else if (mutation.type === "star") {
          const result = await starMutation.mutateAsync({
            id: mutation.entryId,
            changedAt: mutation.changedAt,
          });

          handleEntryStarred(utils, result.entry.id, result.entry.read, queryClient);
        } else if (mutation.type === "unstar") {
          const result = await unstarMutation.mutateAsync({
            id: mutation.entryId,
            changedAt: mutation.changedAt,
          });

          handleEntryUnstarred(utils, result.entry.id, result.entry.read, queryClient);
        }

        // Success - remove from queue
        await store.remove(mutation.id);

        // Update in-memory cache
        queuedStatesRef.current.delete(mutation.entryId);

        return true;
      } catch (error) {
        console.error("Mutation failed:", error);

        // Update retry count
        const newRetryCount = mutation.retryCount + 1;
        if (newRetryCount >= MAX_RETRIES) {
          // Max retries reached, mark as failed
          await store.update({
            ...mutation,
            status: "failed",
            retryCount: newRetryCount,
            lastError: error instanceof Error ? error.message : "Unknown error",
          });
        } else {
          // Reset to pending for retry
          await store.update({
            ...mutation,
            status: "pending",
            retryCount: newRetryCount,
            lastError: error instanceof Error ? error.message : "Unknown error",
          });
        }

        return false;
      }
    },
    [markReadMutation, starMutation, unstarMutation, utils, queryClient]
  );

  // Sync all pending mutations
  const syncQueue = useCallback(async () => {
    const store = storeRef.current;
    if (!store || syncLockRef.current || !isOnline) return;

    syncLockRef.current = true;
    setIsSyncing(true);

    try {
      let pending = await store.getPending();

      while (pending.length > 0 && isOnline) {
        const mutation = pending[0];

        // Apply backoff delay if this is a retry
        if (mutation.retryCount > 0) {
          const delay = RETRY_DELAYS[Math.min(mutation.retryCount - 1, RETRY_DELAYS.length - 1)];
          await new Promise((resolve) => setTimeout(resolve, delay));
        }

        const success = await processMutation(mutation);

        if (!success) {
          // If mutation failed, check if we should continue or stop
          // (e.g., if we're now offline)
          if (!navigator.onLine) break;
        }

        // Refresh pending list
        pending = await store.getPending();
        setPendingCount(pending.length);
      }
    } finally {
      syncLockRef.current = false;
      setIsSyncing(false);

      // Update final count
      if (store) {
        const count = await store.getPendingCount();
        setPendingCount(count);
      }
    }
  }, [isOnline, processMutation]);

  // Auto-sync when coming online
  useEffect(() => {
    if (isOnline && isReady && pendingCount > 0) {
      syncQueue();
    }
  }, [isOnline, isReady, pendingCount, syncQueue]);

  // Queue a mutation
  const queueMutation = useCallback(
    async (
      type: MutationType,
      entryId: string,
      entryContext: EntryContext,
      read?: boolean
    ): Promise<void> => {
      const store = storeRef.current;
      const changedAt = new Date();
      const queuedAt = new Date();

      // Update in-memory cache immediately for optimistic UI
      const existing = queuedStatesRef.current.get(entryId) ?? {};
      if (type === "markRead") {
        existing.read = read;
      } else if (type === "star") {
        existing.starred = true;
      } else if (type === "unstar") {
        existing.starred = false;
      }
      queuedStatesRef.current.set(entryId, existing);

      // Apply optimistic update to cache immediately
      if (type === "markRead") {
        handleEntriesMarkedRead(utils, [entryContext], read!, queryClient);
      } else if (type === "star") {
        handleEntryStarred(utils, entryId, entryContext.starred ? true : false, queryClient);
      } else if (type === "unstar") {
        handleEntryUnstarred(utils, entryId, entryContext.starred ? true : false, queryClient);
      }

      if (!store) {
        // IndexedDB not available, try direct mutation
        if (isOnline) {
          const mutation: QueuedMutation = {
            id: generateUuidv7(),
            type,
            entryId,
            changedAt,
            entryContext,
            read,
            retryCount: 0,
            queuedAt,
            status: "pending",
          };
          await processMutation(mutation);
        }
        return;
      }

      // Remove any existing pending mutations for this entry that this supersedes
      // (e.g., if user clicks read then unread quickly)
      await store.removeAllForEntry(entryId);

      const mutation: QueuedMutation = {
        id: generateUuidv7(),
        type,
        entryId,
        changedAt,
        entryContext,
        read,
        retryCount: 0,
        queuedAt,
        status: "pending",
      };

      await store.add(mutation);
      setPendingCount((prev) => prev + 1);

      // If online, start syncing immediately
      if (isOnline) {
        // Don't await - let it sync in the background
        syncQueue();
      }
    },
    [isOnline, processMutation, syncQueue, utils, queryClient]
  );

  // Public API methods
  const queueMarkRead = useCallback(
    async (entryId: string, read: boolean, entryContext: EntryContext) => {
      await queueMutation("markRead", entryId, entryContext, read);
    },
    [queueMutation]
  );

  const queueStar = useCallback(
    async (entryId: string, entryContext: EntryContext) => {
      await queueMutation("star", entryId, entryContext);
    },
    [queueMutation]
  );

  const queueUnstar = useCallback(
    async (entryId: string, entryContext: EntryContext) => {
      await queueMutation("unstar", entryId, entryContext);
    },
    [queueMutation]
  );

  const getQueuedState = useCallback(
    (entryId: string): { read?: boolean; starred?: boolean } | undefined => {
      return queuedStatesRef.current.get(entryId);
    },
    []
  );

  const syncNow = useCallback(async () => {
    await syncQueue();
  }, [syncQueue]);

  return useMemo(
    () => ({
      isReady,
      isOnline,
      pendingCount,
      isSyncing,
      queueMarkRead,
      queueStar,
      queueUnstar,
      getQueuedState,
      syncNow,
    }),
    [
      isReady,
      isOnline,
      pendingCount,
      isSyncing,
      queueMarkRead,
      queueStar,
      queueUnstar,
      getQueuedState,
      syncNow,
    ]
  );
}
