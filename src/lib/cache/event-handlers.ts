/**
 * Shared Event Handlers
 *
 * Provides unified event handling for both SSE and sync endpoints.
 * Both SSE real-time events and sync polling use the same event types,
 * so we can share the cache update logic between them.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  handleNewEntry,
  updateEntriesInListCache,
  updateEntryMetadataInCache,
  applySyncTagChanges,
  removeSyncTags,
} from "./index";

// ============================================================================
// Event Types
// ============================================================================

/**
 * Entry metadata for entry_updated events.
 */
export interface EntryMetadata {
  title: string | null;
  author: string | null;
  summary: string | null;
  url: string | null;
  publishedAt: string | null;
}

/**
 * new_entry event.
 */
export interface NewEntryEvent {
  type: "new_entry";
  subscriptionId: string | null;
  entryId: string;
  timestamp: string;
  feedType?: "web" | "email" | "saved";
}

/**
 * entry_updated event.
 */
export interface EntryUpdatedEvent {
  type: "entry_updated";
  subscriptionId: string | null;
  entryId: string;
  timestamp: string;
  metadata: EntryMetadata;
}

/**
 * entry_state_changed event.
 */
export interface EntryStateChangedEvent {
  type: "entry_state_changed";
  entryId: string;
  read: boolean;
  starred: boolean;
  timestamp: string;
}

/**
 * Subscription data for subscription_created events.
 */
export interface SubscriptionCreatedData {
  id: string;
  feedId: string;
  customTitle: string | null;
  subscribedAt: string;
  unreadCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
}

/**
 * Feed data for subscription_created events.
 */
export interface FeedCreatedData {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  description: string | null;
  siteUrl: string | null;
}

/**
 * subscription_created event.
 */
export interface SubscriptionCreatedEvent {
  type: "subscription_created";
  subscriptionId: string;
  feedId: string;
  timestamp: string;
  subscription: SubscriptionCreatedData;
  feed: FeedCreatedData;
}

/**
 * subscription_deleted event.
 */
export interface SubscriptionDeletedEvent {
  type: "subscription_deleted";
  subscriptionId: string;
  timestamp: string;
}

/**
 * Tag data for tag events.
 */
export interface TagData {
  id: string;
  name: string;
  color: string | null;
}

/**
 * tag_created event.
 */
export interface TagCreatedEvent {
  type: "tag_created";
  tag: TagData;
  timestamp: string;
}

/**
 * tag_updated event.
 */
export interface TagUpdatedEvent {
  type: "tag_updated";
  tag: TagData;
  timestamp: string;
}

/**
 * tag_deleted event.
 */
export interface TagDeletedEvent {
  type: "tag_deleted";
  tagId: string;
  timestamp: string;
}

/**
 * import_progress event.
 */
export interface ImportProgressEvent {
  type: "import_progress";
  importId: string;
  feedUrl: string;
  feedStatus: "imported" | "skipped" | "failed";
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  timestamp: string;
}

/**
 * import_completed event.
 */
export interface ImportCompletedEvent {
  type: "import_completed";
  importId: string;
  imported: number;
  skipped: number;
  failed: number;
  total: number;
  timestamp: string;
}

/**
 * Union type for all sync events.
 */
export type SyncEvent =
  | NewEntryEvent
  | EntryUpdatedEvent
  | EntryStateChangedEvent
  | SubscriptionCreatedEvent
  | SubscriptionDeletedEvent
  | TagCreatedEvent
  | TagUpdatedEvent
  | TagDeletedEvent
  | ImportProgressEvent
  | ImportCompletedEvent;

// ============================================================================
// Event Handler
// ============================================================================

/**
 * Handles a sync event by updating the appropriate caches.
 *
 * This is the unified event handler used by both SSE and sync endpoints.
 * It dispatches to the appropriate cache update functions based on event type.
 *
 * @param utils - tRPC utils for cache access
 * @param queryClient - React Query client for cache updates
 * @param event - The event to handle
 */
export function handleSyncEvent(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  event: SyncEvent
): void {
  switch (event.type) {
    case "new_entry":
      // Update unread counts without invalidating entries.list
      if (event.feedType) {
        handleNewEntry(utils, event.subscriptionId, event.feedType, queryClient);
      }
      break;

    case "entry_updated":
      // Update entry metadata directly in caches
      updateEntryMetadataInCache(
        utils,
        event.entryId,
        {
          title: event.metadata.title,
          author: event.metadata.author,
          summary: event.metadata.summary,
          url: event.metadata.url,
          publishedAt: event.metadata.publishedAt ? new Date(event.metadata.publishedAt) : null,
        },
        queryClient
      );
      break;

    case "entry_state_changed":
      // Update read/starred state in cache
      updateEntriesInListCache(queryClient, [event.entryId], {
        read: event.read,
        starred: event.starred,
      });
      break;

    case "subscription_created": {
      const { subscription, feed } = event;
      handleSubscriptionCreated(
        utils,
        {
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
        },
        queryClient
      );
      break;
    }

    case "subscription_deleted":
      // Check if already removed (optimistic update from same tab)
      {
        const currentData = utils.subscriptions.list.getData();
        const alreadyRemoved =
          currentData && !currentData.items.some((s) => s.id === event.subscriptionId);

        if (!alreadyRemoved) {
          handleSubscriptionDeleted(utils, event.subscriptionId, queryClient);
        }
      }
      break;

    case "tag_created":
      applySyncTagChanges(utils, [event.tag], []);
      break;

    case "tag_updated":
      applySyncTagChanges(utils, [], [event.tag]);
      break;

    case "tag_deleted":
      removeSyncTags(utils, [event.tagId]);
      break;

    case "import_progress":
      utils.imports.get.invalidate({ id: event.importId });
      utils.imports.list.invalidate();
      break;

    case "import_completed":
      utils.imports.get.invalidate({ id: event.importId });
      utils.imports.list.invalidate();
      break;
  }
}

/**
 * Type guard to check if a parsed object is a valid SyncEvent.
 */
export function isSyncEvent(obj: unknown): obj is SyncEvent {
  if (typeof obj !== "object" || obj === null || !("type" in obj)) {
    return false;
  }

  const event = obj as Record<string, unknown>;

  switch (event.type) {
    case "new_entry":
      return (
        (typeof event.subscriptionId === "string" || event.subscriptionId === null) &&
        typeof event.entryId === "string"
      );

    case "entry_updated":
      return (
        (typeof event.subscriptionId === "string" || event.subscriptionId === null) &&
        typeof event.entryId === "string" &&
        typeof event.metadata === "object" &&
        event.metadata !== null
      );

    case "entry_state_changed":
      return (
        typeof event.entryId === "string" &&
        typeof event.read === "boolean" &&
        typeof event.starred === "boolean"
      );

    case "subscription_created":
      return (
        typeof event.subscriptionId === "string" &&
        typeof event.feedId === "string" &&
        typeof event.subscription === "object" &&
        event.subscription !== null &&
        typeof event.feed === "object" &&
        event.feed !== null
      );

    case "subscription_deleted":
      return typeof event.subscriptionId === "string";

    case "tag_created":
    case "tag_updated":
      return typeof event.tag === "object" && event.tag !== null;

    case "tag_deleted":
      return typeof event.tagId === "string";

    case "import_progress":
      return typeof event.importId === "string" && typeof event.feedUrl === "string";

    case "import_completed":
      return typeof event.importId === "string";

    default:
      return false;
  }
}
