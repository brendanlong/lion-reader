/**
 * useRealtimeUpdates Hook
 *
 * Manages real-time updates with SSE as primary and polling as fallback.
 *
 * Features:
 * - Primary: Server-Sent Events (SSE) via Redis pub/sub
 * - Fallback: Polling sync endpoint when SSE is unavailable (Redis down)
 * - Automatic catch-up sync after SSE reconnection
 * - Exponential backoff for reconnection attempts
 * - React Query cache invalidation
 * - Granular cursor tracking for each entity type (entries, subscriptions, tags, etc.)
 */

"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import {
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  handleNewEntry,
  updateEntriesInListCache,
} from "@/lib/cache";

/**
 * Granular sync cursors for each entity type.
 * Each cursor is an ISO8601 timestamp derived from the actual last item in its query result.
 */
export interface SyncCursors {
  entries: string | null;
  entryStates: string | null;
  subscriptions: string | null;
  removedSubscriptions: string | null;
  tags: string | null;
}

/**
 * Connection status for real-time updates.
 */
export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error" | "polling";

/**
 * Return type for the useRealtimeUpdates hook.
 */
export interface UseRealtimeUpdatesResult {
  /**
   * Current connection status.
   * - "connected": SSE connection is active
   * - "polling": Fallback polling mode (SSE unavailable)
   * - "connecting": Attempting to connect
   * - "disconnected": Not connected (not authenticated)
   * - "error": Connection failed
   */
  status: ConnectionStatus;

  /**
   * Whether real-time updates are active (either SSE or polling).
   */
  isConnected: boolean;

  /**
   * Whether we're in fallback polling mode.
   */
  isPolling: boolean;

  /**
   * Manually trigger a reconnection attempt.
   */
  reconnect: () => void;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Maximum reconnection delay in milliseconds (30 seconds).
 */
const MAX_RECONNECT_DELAY_MS = 30_000;

/**
 * Initial reconnection delay in milliseconds (1 second).
 */
const INITIAL_RECONNECT_DELAY_MS = 1_000;

/**
 * Backoff multiplier for exponential backoff.
 */
const BACKOFF_MULTIPLIER = 2;

/**
 * Polling interval when in fallback mode (30 seconds).
 */
const POLL_INTERVAL_MS = 30_000;

/**
 * How often to retry SSE while in polling mode (60 seconds).
 */
const SSE_RETRY_INTERVAL_MS = 60_000;

// ============================================================================
// Event Types
// ============================================================================

/**
 * Entry events from SSE, transformed to include subscriptionId.
 * These are published at the feed level internally but transformed
 * by the SSE endpoint to be subscription-centric for clients.
 */
interface SubscriptionEntryEventData {
  type: "new_entry" | "entry_updated";
  subscriptionId: string;
  entryId: string;
  timestamp: string;
  feedType?: "web" | "email" | "saved"; // Included for new_entry to enable cache updates
}

interface SubscriptionCreatedEventSubscription {
  id: string;
  feedId: string;
  customTitle: string | null;
  subscribedAt: string;
  unreadCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
}

interface SubscriptionCreatedEventFeed {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  description: string | null;
  siteUrl: string | null;
}

interface SubscriptionCreatedEventData {
  type: "subscription_created";
  userId: string;
  feedId: string;
  subscriptionId: string;
  timestamp: string;
  subscription: SubscriptionCreatedEventSubscription;
  feed: SubscriptionCreatedEventFeed;
}

interface SubscriptionDeletedEventData {
  type: "subscription_deleted";
  userId: string;
  feedId: string;
  subscriptionId: string;
  timestamp: string;
}

interface SavedArticleCreatedEventData {
  type: "saved_article_created";
  userId: string;
  entryId: string;
  timestamp: string;
}

interface SavedArticleUpdatedEventData {
  type: "saved_article_updated";
  userId: string;
  entryId: string;
  timestamp: string;
}

interface ImportProgressEventData {
  type: "import_progress";
  userId: string;
  importId: string;
  feedUrl: string;
  feedStatus: "imported" | "skipped" | "failed";
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  timestamp: string;
}

interface ImportCompletedEventData {
  type: "import_completed";
  userId: string;
  importId: string;
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  timestamp: string;
}

type UserEventData =
  | SubscriptionCreatedEventData
  | SubscriptionDeletedEventData
  | SavedArticleCreatedEventData
  | SavedArticleUpdatedEventData
  | ImportProgressEventData
  | ImportCompletedEventData;

type SSEEventData = SubscriptionEntryEventData | UserEventData;

/**
 * Parses SSE event data from a JSON string.
 */
function parseEventData(data: string): SSEEventData | null {
  try {
    const parsed: unknown = JSON.parse(data);

    if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
      return null;
    }

    const event = parsed as Record<string, unknown>;

    // Handle feed events (now include subscriptionId instead of feedId)
    if (
      (event.type === "new_entry" || event.type === "entry_updated") &&
      typeof event.subscriptionId === "string" &&
      typeof event.entryId === "string"
    ) {
      return {
        type: event.type,
        subscriptionId: event.subscriptionId,
        entryId: event.entryId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        feedType:
          typeof event.feedType === "string" && ["web", "email", "saved"].includes(event.feedType)
            ? (event.feedType as "web" | "email" | "saved")
            : undefined,
      };
    }

    // Handle user events - subscription_created
    if (
      event.type === "subscription_created" &&
      typeof event.userId === "string" &&
      typeof event.feedId === "string" &&
      typeof event.subscriptionId === "string" &&
      typeof event.subscription === "object" &&
      event.subscription !== null &&
      typeof event.feed === "object" &&
      event.feed !== null
    ) {
      const sub = event.subscription as Record<string, unknown>;
      const feed = event.feed as Record<string, unknown>;

      // Validate subscription structure
      if (
        typeof sub.id !== "string" ||
        typeof sub.feedId !== "string" ||
        (sub.customTitle !== null && typeof sub.customTitle !== "string") ||
        typeof sub.subscribedAt !== "string" ||
        typeof sub.unreadCount !== "number" ||
        !Array.isArray(sub.tags)
      ) {
        return null;
      }

      // Validate feed structure
      if (
        typeof feed.id !== "string" ||
        (feed.type !== "web" && feed.type !== "email" && feed.type !== "saved") ||
        (feed.url !== null && typeof feed.url !== "string") ||
        (feed.title !== null && typeof feed.title !== "string") ||
        (feed.description !== null && typeof feed.description !== "string") ||
        (feed.siteUrl !== null && typeof feed.siteUrl !== "string")
      ) {
        return null;
      }

      return {
        type: event.type,
        userId: event.userId,
        feedId: event.feedId,
        subscriptionId: event.subscriptionId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        subscription: {
          id: sub.id,
          feedId: sub.feedId,
          customTitle: sub.customTitle as string | null,
          subscribedAt: sub.subscribedAt,
          unreadCount: sub.unreadCount,
          tags: sub.tags as Array<{ id: string; name: string; color: string | null }>,
        },
        feed: {
          id: feed.id,
          type: feed.type,
          url: feed.url as string | null,
          title: feed.title as string | null,
          description: feed.description as string | null,
          siteUrl: feed.siteUrl as string | null,
        },
      };
    }

    // Handle user events - subscription_deleted
    if (
      event.type === "subscription_deleted" &&
      typeof event.userId === "string" &&
      typeof event.feedId === "string" &&
      typeof event.subscriptionId === "string"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        feedId: event.feedId,
        subscriptionId: event.subscriptionId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    // Handle user events - saved_article_created
    if (
      event.type === "saved_article_created" &&
      typeof event.userId === "string" &&
      typeof event.entryId === "string"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        entryId: event.entryId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    // Handle user events - saved_article_updated
    if (
      event.type === "saved_article_updated" &&
      typeof event.userId === "string" &&
      typeof event.entryId === "string"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        entryId: event.entryId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    // Handle user events - import_progress
    if (
      event.type === "import_progress" &&
      typeof event.userId === "string" &&
      typeof event.importId === "string" &&
      typeof event.feedUrl === "string" &&
      (event.feedStatus === "imported" ||
        event.feedStatus === "skipped" ||
        event.feedStatus === "failed") &&
      typeof event.imported === "number" &&
      typeof event.skipped === "number" &&
      typeof event.failed === "number" &&
      typeof event.total === "number"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        importId: event.importId,
        feedUrl: event.feedUrl,
        feedStatus: event.feedStatus,
        imported: event.imported,
        skipped: event.skipped,
        failed: event.failed,
        total: event.total,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    // Handle user events - import_completed
    if (
      event.type === "import_completed" &&
      typeof event.userId === "string" &&
      typeof event.importId === "string" &&
      typeof event.imported === "number" &&
      typeof event.skipped === "number" &&
      typeof event.failed === "number" &&
      typeof event.total === "number"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        importId: event.importId,
        imported: event.imported,
        skipped: event.skipped,
        failed: event.failed,
        total: event.total,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// Hook
// ============================================================================

/**
 * Hook to manage real-time updates with SSE primary and polling fallback.
 *
 * @param initialCursors - Initial sync cursors from server (one per entity type)
 *
 * @example
 * ```tsx
 * function AppLayout({ children }) {
 *   // Get initial cursors from server or use null for initial sync
 *   const initialCursors: SyncCursors = { entries: null, entryStates: null, subscriptions: null, removedSubscriptions: null, tags: null };
 *   const { status, isConnected, isPolling } = useRealtimeUpdates(initialCursors);
 *
 *   return (
 *     <div>
 *       {isPolling && <PollingModeBanner />}
 *       {!isConnected && <ReconnectingBanner />}
 *       {children}
 *     </div>
 *   );
 * }
 * ```
 */
export function useRealtimeUpdates(initialCursors: SyncCursors): UseRealtimeUpdatesResult {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  // Connection status state
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>("disconnected");
  const [isPollingMode, setIsPollingMode] = useState(false);

  // Refs to persist across renders
  const eventSourceRef = useRef<EventSource | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sseRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY_MS);
  const isManuallyClosedRef = useRef(false);
  const shouldConnectRef = useRef(false);
  // Initialize with server-provided cursors (granular tracking per entity type)
  const cursorsRef = useRef<SyncCursors>(initialCursors);

  // State to trigger reconnection
  const [reconnectTrigger, setReconnectTrigger] = useState(0);

  // Check if user is authenticated
  const userQuery = trpc.auth.me.useQuery(undefined, {
    retry: false,
    refetchOnWindowFocus: false,
  });

  const isAuthenticated = userQuery.isSuccess && userQuery.data?.user;

  /**
   * Cleans up all connections and intervals.
   */
  const cleanup = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }

    if (sseRetryTimeoutRef.current) {
      clearTimeout(sseRetryTimeoutRef.current);
      sseRetryTimeoutRef.current = null;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  /**
   * Handles incoming SSE events by updating or invalidating relevant caches.
   * Uses direct cache updates where possible to avoid full refetches.
   *
   * Note: SSE events provide real-time updates, so we don't need to update cursors here.
   * The cursors are updated via performSync() after reconnection or during polling.
   */
  const handleEvent = useCallback(
    (event: MessageEvent) => {
      // SSE lastEventId is still tracked by the browser for reconnection,
      // but we don't update cursorsRef here - that happens in performSync()

      const data = parseEventData(event.data);
      if (!data) return;

      if (data.type === "new_entry") {
        // Update unread counts surgically without invalidating entries.list
        // This allows smooth scrolling while keeping counts fresh
        // New entries appear when user navigates to that feed/view
        if (data.feedType) {
          handleNewEntry(utils, data.subscriptionId, data.feedType, queryClient);
        }
      } else if (data.type === "entry_updated") {
        // Invalidate the specific entry to refresh content
        utils.entries.get.invalidate({ id: data.entryId });
      } else if (data.type === "subscription_created") {
        // Use high-level operation - handles cache add + tag invalidation
        const { subscription, feed } = data;
        handleSubscriptionCreated(utils, {
          id: subscription.id,
          type: feed.type,
          url: feed.url,
          title: subscription.customTitle ?? feed.title,
          originalTitle: feed.title,
          description: feed.description,
          siteUrl: feed.siteUrl,
          subscribedAt: new Date(subscription.subscribedAt),
          unreadCount: subscription.unreadCount,
          tags: subscription.tags,
          fetchFullContent: false,
        });
      } else if (data.type === "subscription_deleted") {
        // Check if already removed (optimistic update from same tab)
        const currentData = utils.subscriptions.list.getData();
        const alreadyRemoved =
          currentData && !currentData.items.some((s) => s.id === data.subscriptionId);

        if (!alreadyRemoved) {
          // Use high-level operation - handles cache remove + invalidations
          handleSubscriptionDeleted(utils, data.subscriptionId);
        }
      } else if (data.type === "saved_article_created") {
        utils.entries.list.invalidate({ type: "saved" });
        utils.entries.count.invalidate({ type: "saved" });
      } else if (data.type === "saved_article_updated") {
        utils.entries.get.invalidate({ id: data.entryId });
        utils.entries.list.invalidate({ type: "saved" });
      } else if (data.type === "import_progress") {
        utils.imports.get.invalidate({ id: data.importId });
        utils.imports.list.invalidate();
        // Don't invalidate subscriptions on each import_progress - import_completed handles it
        // This avoids N refetches for N imported feeds
      } else if (data.type === "import_completed") {
        utils.imports.get.invalidate({ id: data.importId });
        utils.imports.list.invalidate();
        // Subscriptions and tags are already updated via individual subscription_created events
        // Only invalidate entries since we may have new entries from newly imported feeds
        utils.entries.list.invalidate();
      }
    },
    [utils, queryClient]
  );

  /**
   * Performs a sync and updates caches appropriately.
   * Uses granular cursors to ensure no changes are missed between syncs.
   * Used during polling mode and for catch-up sync after SSE reconnection.
   *
   * Entry state changes (read/starred) are applied directly to the cache to avoid
   * unnecessary refetches - this prevents the list from refreshing when we've
   * already updated the cache optimistically via mutations.
   */
  const performSync = useCallback(async () => {
    try {
      const currentCursors = cursorsRef.current;
      const result = await utils.client.sync.changes.query({
        // Use granular cursors for correct incremental sync
        cursors: {
          entries: currentCursors.entries ?? undefined,
          entryStates: currentCursors.entryStates ?? undefined,
          subscriptions: currentCursors.subscriptions ?? undefined,
          removedSubscriptions: currentCursors.removedSubscriptions ?? undefined,
          tags: currentCursors.tags ?? undefined,
        },
      });

      // Update cursors from the response (derived from actual query results)
      cursorsRef.current = result.cursors;

      // Handle entry state updates (read/starred changes) by updating cache directly
      // This avoids refetching the list when we've already applied optimistic updates
      if (result.entries.updated.length > 0) {
        // Group updates by their state for efficient batch updates
        for (const entry of result.entries.updated) {
          updateEntriesInListCache(queryClient, [entry.id], {
            read: entry.read,
            starred: entry.starred,
          });
        }
      }

      // Only invalidate entries.list for actual structural changes (new/removed entries)
      // NOT for read/starred state updates which we handle above
      const hasStructuralEntryChanges =
        result.entries.created.length > 0 || result.entries.removed.length > 0;

      const hasSubscriptionChanges =
        result.subscriptions.created.length > 0 || result.subscriptions.removed.length > 0;

      const hasTagChanges = result.tags.created.length > 0 || result.tags.removed.length > 0;

      // Handle structural entry changes - invalidate list
      if (hasStructuralEntryChanges) {
        utils.entries.list.invalidate();
        utils.subscriptions.list.invalidate();
      }

      // Handle subscription changes - only invalidate subscriptions.list, not entries.list
      // Subscription creates/deletes don't affect which entries are visible in the current view.
      // New entries from new subscriptions will appear when the user navigates to that feed.
      // Removed subscriptions won't have their entries shown after navigation away.
      if (hasSubscriptionChanges) {
        utils.subscriptions.list.invalidate();
      }

      if (hasTagChanges) {
        utils.tags.list.invalidate();
      }

      return result.cursors;
    } catch (error) {
      console.error("Sync failed:", error);
      return null;
    }
  }, [utils.client.sync.changes, utils.entries, utils.subscriptions, utils.tags, queryClient]);

  /**
   * Starts polling mode when SSE is unavailable.
   */
  const startPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      return; // Already polling
    }

    setIsPollingMode(true);
    setConnectionStatus("polling");

    // cursorsRef already initialized with server-provided cursors

    // Start polling interval
    pollIntervalRef.current = setInterval(() => {
      performSync();
    }, POLL_INTERVAL_MS);

    // Do an immediate sync
    performSync();
  }, [performSync]);

  /**
   * Stops polling mode.
   */
  const stopPolling = useCallback(() => {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setIsPollingMode(false);
  }, []);

  /**
   * Schedules a reconnection attempt with exponential backoff.
   */
  const scheduleReconnect = useCallback((connectFn: () => void) => {
    if (isManuallyClosedRef.current || !shouldConnectRef.current) return;

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }

    const delay = reconnectDelayRef.current;

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectDelayRef.current = Math.min(
        reconnectDelayRef.current * BACKOFF_MULTIPLIER,
        MAX_RECONNECT_DELAY_MS
      );
      connectFn();
    }, delay);
  }, []);

  /**
   * Manual reconnection function exposed to consumers.
   */
  const reconnect = useCallback(() => {
    reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;
    isManuallyClosedRef.current = false;
    shouldConnectRef.current = true;

    cleanup();
    stopPolling();

    setReconnectTrigger((prev) => prev + 1);
  }, [cleanup, stopPolling]);

  // Effect to manage SSE connection based on authentication
  useEffect(() => {
    shouldConnectRef.current = !!isAuthenticated;

    if (!isAuthenticated) {
      isManuallyClosedRef.current = true;
      cleanup();
      stopPolling();
      return;
    }

    // Already connected, nothing to do
    if (eventSourceRef.current?.readyState === EventSource.OPEN) {
      return;
    }

    // Clean up any existing connection
    cleanup();
    isManuallyClosedRef.current = false;

    const createConnection = async () => {
      if (!shouldConnectRef.current || isManuallyClosedRef.current) {
        return;
      }

      setConnectionStatus("connecting");

      try {
        // First, try a fetch to check if SSE is available
        // This handles the 503 case where Redis is down
        const response = await fetch("/api/v1/events", {
          method: "GET",
          credentials: "include",
          headers: {
            Accept: "text/event-stream",
          },
        });

        // If we get a 503, switch to polling mode
        if (response.status === 503) {
          console.log("SSE unavailable (503), switching to polling mode");
          startPolling();

          // Schedule periodic SSE retry
          sseRetryTimeoutRef.current = setTimeout(() => {
            if (shouldConnectRef.current && !isManuallyClosedRef.current) {
              stopPolling();
              createConnection();
            }
          }, SSE_RETRY_INTERVAL_MS);

          return;
        }

        // If not OK, treat as error
        if (!response.ok) {
          throw new Error(`SSE request failed with status ${response.status}`);
        }

        // Close the fetch response since we'll use EventSource
        // The fetch was just to check availability
        response.body?.cancel();

        // Create EventSource connection
        const eventSource = new EventSource("/api/v1/events", {
          withCredentials: true,
        });

        eventSourceRef.current = eventSource;

        eventSource.onopen = () => {
          setConnectionStatus("connected");
          reconnectDelayRef.current = INITIAL_RECONNECT_DELAY_MS;

          // Stop polling if we were in polling mode
          stopPolling();

          // Clear SSE retry timeout
          if (sseRetryTimeoutRef.current) {
            clearTimeout(sseRetryTimeoutRef.current);
            sseRetryTimeoutRef.current = null;
          }

          // Perform a catch-up sync to get any changes we might have missed
          // The cursorsRef is already initialized, so performSync will work correctly
          performSync();
        };

        // Handle named events
        eventSource.addEventListener("connected", handleEvent); // Initial cursor from server
        eventSource.addEventListener("new_entry", handleEvent);
        eventSource.addEventListener("entry_updated", handleEvent);
        eventSource.addEventListener("subscription_created", handleEvent);
        eventSource.addEventListener("subscription_deleted", handleEvent);
        eventSource.addEventListener("saved_article_created", handleEvent);
        eventSource.addEventListener("saved_article_updated", handleEvent);
        eventSource.addEventListener("import_progress", handleEvent);
        eventSource.addEventListener("import_completed", handleEvent);

        eventSource.onerror = () => {
          if (eventSourceRef.current?.readyState === EventSource.CLOSED) {
            setConnectionStatus("error");
            cleanup();
            scheduleReconnect(createConnection);
          } else {
            setConnectionStatus("connecting");
          }
        };
      } catch (error) {
        console.error("Failed to create SSE connection:", error);
        setConnectionStatus("error");

        // On connection failure, try polling as fallback
        startPolling();

        // Schedule SSE retry
        sseRetryTimeoutRef.current = setTimeout(() => {
          if (shouldConnectRef.current && !isManuallyClosedRef.current) {
            stopPolling();
            createConnection();
          }
        }, SSE_RETRY_INTERVAL_MS);
      }
    };

    createConnection();

    return () => {
      isManuallyClosedRef.current = true;
      cleanup();
      stopPolling();
    };
  }, [
    isAuthenticated,
    reconnectTrigger,
    cleanup,
    handleEvent,
    scheduleReconnect,
    startPolling,
    stopPolling,
    performSync,
  ]);

  // Handle visibility change - reconnect when tab becomes visible
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (
        document.visibilityState === "visible" &&
        isAuthenticated &&
        eventSourceRef.current?.readyState !== EventSource.OPEN
      ) {
        // If in polling mode, do an immediate sync
        if (isPollingMode) {
          performSync();
        } else {
          reconnect();
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [isAuthenticated, isPollingMode, performSync, reconnect]);

  // Derive the effective status
  const effectiveStatus: ConnectionStatus = isAuthenticated ? connectionStatus : "disconnected";

  return {
    status: effectiveStatus,
    isConnected: effectiveStatus === "connected" || effectiveStatus === "polling",
    isPolling: isPollingMode,
    reconnect,
  };
}
