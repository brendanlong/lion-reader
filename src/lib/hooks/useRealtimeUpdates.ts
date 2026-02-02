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
import { handleSyncEvent, type SyncEvent } from "@/lib/cache";

/**
 * Sync cursors for each entity type.
 * Each cursor is an ISO8601 timestamp based on max(updated_at) for the entity type.
 */
export interface SyncCursors {
  entries: string | null;
  subscriptions: string | null;
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
 * Entry metadata included in entry_updated events.
 */
interface EntryUpdatedMetadata {
  title: string | null;
  author: string | null;
  summary: string | null;
  url: string | null;
  publishedAt: string | null; // ISO string
}

/**
 * new_entry event from SSE.
 */
interface NewEntryEventData {
  type: "new_entry";
  subscriptionId: string | null;
  entryId: string;
  timestamp: string;
  updatedAt: string; // Database updated_at for cursor tracking (entries cursor)
  feedType?: "web" | "email" | "saved";
}

/**
 * entry_updated event from SSE.
 */
interface EntryUpdatedEventData {
  type: "entry_updated";
  subscriptionId: string | null;
  entryId: string;
  timestamp: string;
  updatedAt: string; // Database updated_at for cursor tracking (entries cursor)
  metadata: EntryUpdatedMetadata;
}

/**
 * Entry events from SSE, transformed to include subscriptionId.
 * These are published at the feed level internally but transformed
 * by the SSE endpoint to be subscription-centric for clients.
 *
 * For saved articles, subscriptionId is null since they don't have subscriptions.
 */
type SubscriptionEntryEventData = NewEntryEventData | EntryUpdatedEventData;

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
  updatedAt: string; // Database updated_at for cursor tracking (subscriptions cursor)
  subscription: SubscriptionCreatedEventSubscription;
  feed: SubscriptionCreatedEventFeed;
}

interface SubscriptionDeletedEventData {
  type: "subscription_deleted";
  userId: string;
  feedId: string;
  subscriptionId: string;
  timestamp: string;
  updatedAt: string; // Database updated_at for cursor tracking (subscriptions cursor)
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

interface EntryStateChangedEventData {
  type: "entry_state_changed";
  entryId: string;
  read: boolean;
  starred: boolean;
  timestamp: string;
  updatedAt: string; // Database updated_at for cursor tracking (entries cursor)
}

interface TagCreatedEventData {
  type: "tag_created";
  tag: { id: string; name: string; color: string | null };
  timestamp: string;
  updatedAt: string; // Database updated_at for cursor tracking (tags cursor)
}

interface TagUpdatedEventData {
  type: "tag_updated";
  tag: { id: string; name: string; color: string | null };
  timestamp: string;
  updatedAt: string; // Database updated_at for cursor tracking (tags cursor)
}

interface TagDeletedEventData {
  type: "tag_deleted";
  tagId: string;
  timestamp: string;
  updatedAt: string; // Database updated_at for cursor tracking (tags cursor)
}

type UserEventData =
  | SubscriptionCreatedEventData
  | SubscriptionDeletedEventData
  | ImportProgressEventData
  | ImportCompletedEventData
  | EntryStateChangedEventData
  | TagCreatedEventData
  | TagUpdatedEventData
  | TagDeletedEventData;

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

    // Handle new_entry events
    if (
      event.type === "new_entry" &&
      (typeof event.subscriptionId === "string" || event.subscriptionId === null) &&
      typeof event.entryId === "string" &&
      typeof event.updatedAt === "string"
    ) {
      return {
        type: "new_entry" as const,
        subscriptionId: event.subscriptionId as string | null,
        entryId: event.entryId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        updatedAt: event.updatedAt,
        feedType:
          typeof event.feedType === "string" && ["web", "email", "saved"].includes(event.feedType)
            ? (event.feedType as "web" | "email" | "saved")
            : undefined,
      };
    }

    // Handle entry_updated events (includes metadata for cache updates)
    if (
      event.type === "entry_updated" &&
      (typeof event.subscriptionId === "string" || event.subscriptionId === null) &&
      typeof event.entryId === "string" &&
      typeof event.updatedAt === "string" &&
      typeof event.metadata === "object" &&
      event.metadata !== null
    ) {
      const metadata = event.metadata as Record<string, unknown>;
      // Validate metadata structure
      if (
        (metadata.title === null || typeof metadata.title === "string") &&
        (metadata.author === null || typeof metadata.author === "string") &&
        (metadata.summary === null || typeof metadata.summary === "string") &&
        (metadata.url === null || typeof metadata.url === "string") &&
        (metadata.publishedAt === null || typeof metadata.publishedAt === "string")
      ) {
        return {
          type: "entry_updated" as const,
          subscriptionId: event.subscriptionId as string | null,
          entryId: event.entryId,
          timestamp:
            typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
          updatedAt: event.updatedAt,
          metadata: {
            title: metadata.title as string | null,
            author: metadata.author as string | null,
            summary: metadata.summary as string | null,
            url: metadata.url as string | null,
            publishedAt: metadata.publishedAt as string | null,
          },
        };
      }
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

      // Require updatedAt for cursor tracking
      if (typeof event.updatedAt !== "string") {
        return null;
      }

      return {
        type: event.type,
        userId: event.userId,
        feedId: event.feedId,
        subscriptionId: event.subscriptionId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        updatedAt: event.updatedAt,
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
      typeof event.subscriptionId === "string" &&
      typeof event.updatedAt === "string"
    ) {
      return {
        type: event.type,
        userId: event.userId,
        feedId: event.feedId,
        subscriptionId: event.subscriptionId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        updatedAt: event.updatedAt,
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

    // Handle entry_state_changed events
    if (
      event.type === "entry_state_changed" &&
      typeof event.entryId === "string" &&
      typeof event.read === "boolean" &&
      typeof event.starred === "boolean" &&
      typeof event.updatedAt === "string"
    ) {
      return {
        type: event.type,
        entryId: event.entryId,
        read: event.read,
        starred: event.starred,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        updatedAt: event.updatedAt,
      };
    }

    // Handle tag_created events
    if (
      event.type === "tag_created" &&
      typeof event.tag === "object" &&
      event.tag !== null &&
      typeof event.updatedAt === "string"
    ) {
      const tag = event.tag as Record<string, unknown>;
      if (
        typeof tag.id === "string" &&
        typeof tag.name === "string" &&
        (tag.color === null || typeof tag.color === "string")
      ) {
        return {
          type: event.type,
          tag: {
            id: tag.id,
            name: tag.name,
            color: tag.color as string | null,
          },
          timestamp:
            typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
          updatedAt: event.updatedAt,
        };
      }
    }

    // Handle tag_updated events
    if (
      event.type === "tag_updated" &&
      typeof event.tag === "object" &&
      event.tag !== null &&
      typeof event.updatedAt === "string"
    ) {
      const tag = event.tag as Record<string, unknown>;
      if (
        typeof tag.id === "string" &&
        typeof tag.name === "string" &&
        (tag.color === null || typeof tag.color === "string")
      ) {
        return {
          type: event.type,
          tag: {
            id: tag.id,
            name: tag.name,
            color: tag.color as string | null,
          },
          timestamp:
            typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
          updatedAt: event.updatedAt,
        };
      }
    }

    // Handle tag_deleted events
    if (
      event.type === "tag_deleted" &&
      typeof event.tagId === "string" &&
      typeof event.updatedAt === "string"
    ) {
      return {
        type: event.type,
        tagId: event.tagId,
        timestamp: typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString(),
        updatedAt: event.updatedAt,
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
 *   const initialCursors: SyncCursors = { entries: null, subscriptions: null, tags: null };
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
   * Updates the appropriate cursor based on the event type.
   * Only updates if the new timestamp is greater than the current cursor.
   */
  const updateCursorForEvent = useCallback((data: SSEEventData) => {
    // Extract updatedAt and determine which cursor to update
    let updatedAt: string | undefined;
    let cursorType: "entries" | "subscriptions" | "tags" | null = null;

    if (
      data.type === "new_entry" ||
      data.type === "entry_updated" ||
      data.type === "entry_state_changed"
    ) {
      updatedAt = data.updatedAt;
      cursorType = "entries";
    } else if (data.type === "subscription_created" || data.type === "subscription_deleted") {
      updatedAt = data.updatedAt;
      cursorType = "subscriptions";
    } else if (
      data.type === "tag_created" ||
      data.type === "tag_updated" ||
      data.type === "tag_deleted"
    ) {
      updatedAt = data.updatedAt;
      cursorType = "tags";
    }

    // Update the cursor if we have a valid updatedAt and it's newer than current
    if (cursorType && updatedAt) {
      const currentCursor = cursorsRef.current[cursorType];
      if (!currentCursor || new Date(updatedAt) > new Date(currentCursor)) {
        cursorsRef.current = {
          ...cursorsRef.current,
          [cursorType]: updatedAt,
        };
      }
    }
  }, []);

  /**
   * Handles incoming SSE events by updating or invalidating relevant caches.
   * Uses the shared handleSyncEvent function for unified event handling.
   *
   * Also updates the appropriate cursor based on the event's updatedAt field
   * to keep cursors in sync as events arrive.
   */
  const handleEvent = useCallback(
    (event: MessageEvent) => {
      const data = parseEventData(event.data);
      if (!data) return;

      // Update the appropriate cursor based on event type
      updateCursorForEvent(data);

      // Convert SSE event to SyncEvent format and delegate to shared handler
      handleSyncEvent(utils, queryClient, data as SyncEvent);
    },
    [utils, queryClient, updateCursorForEvent]
  );

  /**
   * Performs a sync and updates caches appropriately.
   * Uses the sync.changes endpoint with three separate cursors to track each entity type.
   * Used during polling mode and for catch-up sync after SSE reconnection.
   */
  const performSync = useCallback(async () => {
    try {
      const currentCursors = cursorsRef.current;

      const result = await utils.client.sync.changes.query({
        cursors: {
          entries: currentCursors.entries ?? undefined,
          subscriptions: currentCursors.subscriptions ?? undefined,
          tags: currentCursors.tags ?? undefined,
        },
      });

      // Invalidate relevant queries based on changes
      // Note: The changes endpoint returns different data format than events endpoint
      // We handle cache updates differently here since changes are batched by type

      // Handle new/updated entries - invalidate entry lists
      if (result.entries.created.length > 0 || result.entries.updated.length > 0) {
        void utils.entries.list.invalidate();
        void utils.entries.count.invalidate();
      }

      // Handle subscription changes
      if (result.subscriptions.created.length > 0 || result.subscriptions.removed.length > 0) {
        void utils.subscriptions.list.invalidate();
      }

      // Handle tag changes
      if (
        result.tags.created.length > 0 ||
        result.tags.updated.length > 0 ||
        result.tags.removed.length > 0
      ) {
        void utils.tags.list.invalidate();
      }

      // Update cursors from the response (sync.changes returns granular cursors)
      cursorsRef.current = {
        entries: result.cursors.entries,
        subscriptions: result.cursors.subscriptions,
        tags: result.cursors.tags,
      };

      return cursorsRef.current;
    } catch (error) {
      console.error("Sync failed:", error);
      return null;
    }
  }, [utils]);

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
        eventSource.addEventListener("entry_state_changed", handleEvent);
        eventSource.addEventListener("subscription_created", handleEvent);
        eventSource.addEventListener("subscription_deleted", handleEvent);
        eventSource.addEventListener("tag_created", handleEvent);
        eventSource.addEventListener("tag_updated", handleEvent);
        eventSource.addEventListener("tag_deleted", handleEvent);
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
