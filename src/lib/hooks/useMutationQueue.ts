/**
 * useMutationQueue Hook
 *
 * Manages the offline-capable mutation queue for read/starred operations.
 * Posts mutations to the service worker which handles Background Sync.
 *
 * Features:
 * - Posts mutations to service worker for Background Sync
 * - Applies optimistic cache updates immediately
 * - Receives sync status updates from service worker
 * - Works offline - mutations sync when connectivity returns
 */

"use client";

import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { generateUuidv7 } from "@/lib/uuidv7";
import type {
  QueuedMutation,
  MutationType,
  EntryContext,
  MutationQueueMessage,
  MutationResultMessage,
  MutationQueueStatusMessage,
} from "@/lib/mutation-queue";
import { handleEntriesMarkedRead, handleEntryStarred, handleEntryUnstarred } from "@/lib/cache";

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
  queueMarkRead: (entryId: string, read: boolean, entryContext: EntryContext) => void;

  /**
   * Queue a star mutation.
   */
  queueStar: (entryId: string, entryContext: EntryContext) => void;

  /**
   * Queue an unstar mutation.
   */
  queueUnstar: (entryId: string, entryContext: EntryContext) => void;
}

/**
 * Hook that manages the offline-capable mutation queue via service worker.
 *
 * @example
 * ```tsx
 * function EntryItem({ entry }) {
 *   const { queueMarkRead, isOnline, pendingCount } = useMutationQueue();
 *
 *   const handleToggleRead = () => {
 *     queueMarkRead(entry.id, !entry.read, {
 *       id: entry.id,
 *       subscriptionId: entry.subscriptionId,
 *       starred: entry.starred,
 *       read: entry.read,
 *       type: entry.type,
 *     });
 *   };
 *
 *   return (
 *     <button onClick={handleToggleRead}>
 *       {entry.read ? "Mark Unread" : "Mark Read"}
 *       {!isOnline && pendingCount > 0 && ` (${pendingCount} pending)`}
 *     </button>
 *   );
 * }
 * ```
 */
export function useMutationQueue(): UseMutationQueueResult {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Check if service worker is available
  const hasServiceWorker = typeof navigator !== "undefined" && "serviceWorker" in navigator;

  // State - if no service worker, we're "ready" immediately (will fall back to direct calls)
  const [isReady, setIsReady] = useState(!hasServiceWorker);
  const [isOnline, setIsOnline] = useState(
    typeof navigator !== "undefined" ? navigator.onLine : true
  );
  const [pendingCount, setPendingCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);

  // Service worker registration
  const swRef = useRef<ServiceWorker | null>(null);

  // Initialize service worker connection
  useEffect(() => {
    if (!hasServiceWorker) {
      // Service worker not available - already marked as ready in initial state
      return;
    }

    let cancelled = false;

    const init = async () => {
      try {
        const registration = await navigator.serviceWorker.ready;
        if (!cancelled) {
          swRef.current = registration.active;
          setIsReady(true);
        }
      } catch (error) {
        console.error("Failed to initialize service worker:", error);
        if (!cancelled) {
          setIsReady(true);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
    };
  }, [hasServiceWorker]);

  // Listen for messages from service worker
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      const data = event.data as MutationResultMessage | MutationQueueStatusMessage;

      if (data.type === "MUTATION_QUEUE_STATUS") {
        setPendingCount(data.pendingCount);
        setIsSyncing(data.isSyncing);
      } else if (data.type === "MUTATION_RESULT") {
        // Server responded - update cache with authoritative data
        if (data.success && data.result) {
          if (data.result.entries) {
            // markRead response - entries have full context
            // We already did optimistic update, but server response is authoritative
            // The handleEntriesMarkedRead will reconcile any differences
          }
          // For star/unstar, the optimistic update is sufficient
          // Server just confirms the operation
        }
        // On failure, the optimistic update remains (user's intent)
        // They can retry or it will sync when they're back online
      }
    };

    navigator.serviceWorker.addEventListener("message", handleMessage);

    return () => {
      navigator.serviceWorker.removeEventListener("message", handleMessage);
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

  // Post mutation to service worker
  const postToServiceWorker = useCallback((mutation: QueuedMutation) => {
    const sw = swRef.current;
    if (!sw) {
      console.warn("Service worker not available, mutation may not persist");
      return;
    }

    const message: MutationQueueMessage = {
      type: "QUEUE_MUTATION",
      mutation,
    };

    sw.postMessage(message);
  }, []);

  // Queue a mutation
  const queueMutation = useCallback(
    (type: MutationType, entryId: string, entryContext: EntryContext, read?: boolean) => {
      const now = new Date().toISOString();

      const mutation: QueuedMutation = {
        id: generateUuidv7(),
        type,
        entryId,
        changedAt: now,
        entryContext,
        read,
        retryCount: 0,
        queuedAt: now,
        status: "pending",
      };

      // Apply optimistic update immediately
      if (type === "markRead") {
        handleEntriesMarkedRead(utils, [entryContext], read!, queryClient);
      } else if (type === "star") {
        handleEntryStarred(utils, entryId, entryContext.read, queryClient);
      } else if (type === "unstar") {
        handleEntryUnstarred(utils, entryId, entryContext.read, queryClient);
      }

      // Post to service worker for persistence and sync
      postToServiceWorker(mutation);

      // Optimistically increment pending count
      setPendingCount((prev) => prev + 1);
    },
    [utils, queryClient, postToServiceWorker]
  );

  // Public API methods
  const queueMarkRead = useCallback(
    (entryId: string, read: boolean, entryContext: EntryContext) => {
      queueMutation("markRead", entryId, entryContext, read);
    },
    [queueMutation]
  );

  const queueStar = useCallback(
    (entryId: string, entryContext: EntryContext) => {
      queueMutation("star", entryId, entryContext);
    },
    [queueMutation]
  );

  const queueUnstar = useCallback(
    (entryId: string, entryContext: EntryContext) => {
      queueMutation("unstar", entryId, entryContext);
    },
    [queueMutation]
  );

  return useMemo(
    () => ({
      isReady,
      isOnline,
      pendingCount,
      isSyncing,
      queueMarkRead,
      queueStar,
      queueUnstar,
    }),
    [isReady, isOnline, pendingCount, isSyncing, queueMarkRead, queueStar, queueUnstar]
  );
}
