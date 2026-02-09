/**
 * Shared Event Handlers
 *
 * Provides unified event handling for both SSE and sync endpoints.
 * Both SSE real-time events and sync polling use the same event types,
 * so we can share the cache update logic between them.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import type { Collections } from "@/lib/collections";
import { handleSubscriptionCreated, handleSubscriptionDeleted, handleNewEntry } from "./operations";
import { applySyncTagChanges, removeSyncTags } from "./count-cache";
import {
  addTagToCollection,
  updateTagInCollection,
  removeTagFromCollection,
  updateEntryReadInCollection,
  updateEntryStarredInCollection,
  updateEntryMetadataInCollection,
} from "@/lib/collections/writes";

// ============================================================================
// Event Types
// ============================================================================

/**
 * Base fields present on all sync events.
 * `updatedAt` is used for cursor tracking (ISO string from database updated_at).
 */
interface BaseSyncEvent {
  timestamp: string;
  updatedAt: string;
}

/**
 * new_entry event.
 */
interface NewEntryEvent extends BaseSyncEvent {
  type: "new_entry";
  subscriptionId: string | null;
  entryId: string;
  feedType?: "web" | "email" | "saved";
}

/**
 * entry_updated event.
 */
interface EntryUpdatedEvent extends BaseSyncEvent {
  type: "entry_updated";
  subscriptionId: string | null;
  entryId: string;
  metadata: {
    title: string | null;
    author: string | null;
    summary: string | null;
    url: string | null;
    publishedAt: string | null;
  };
}

/**
 * entry_state_changed event.
 */
interface EntryStateChangedEvent extends BaseSyncEvent {
  type: "entry_state_changed";
  entryId: string;
  read: boolean;
  starred: boolean;
}

/**
 * subscription_created event.
 */
interface SubscriptionCreatedEvent extends BaseSyncEvent {
  type: "subscription_created";
  subscriptionId: string;
  feedId: string;
  subscription: {
    id: string;
    feedId: string;
    customTitle: string | null;
    subscribedAt: string;
    unreadCount: number;
    tags: Array<{ id: string; name: string; color: string | null }>;
  };
  feed: {
    id: string;
    type: "web" | "email" | "saved";
    url: string | null;
    title: string | null;
    description: string | null;
    siteUrl: string | null;
  };
}

/**
 * subscription_deleted event.
 */
interface SubscriptionDeletedEvent extends BaseSyncEvent {
  type: "subscription_deleted";
  subscriptionId: string;
}

/**
 * tag_created event.
 */
interface TagCreatedEvent extends BaseSyncEvent {
  type: "tag_created";
  tag: { id: string; name: string; color: string | null };
}

/**
 * tag_updated event.
 */
interface TagUpdatedEvent extends BaseSyncEvent {
  type: "tag_updated";
  tag: { id: string; name: string; color: string | null };
}

/**
 * tag_deleted event.
 */
interface TagDeletedEvent extends BaseSyncEvent {
  type: "tag_deleted";
  tagId: string;
}

/**
 * import_progress event.
 */
interface ImportProgressEvent extends BaseSyncEvent {
  type: "import_progress";
  importId: string;
  feedUrl: string;
  feedStatus: "imported" | "skipped" | "failed";
  imported: number;
  skipped: number;
  failed: number;
  total: number;
}

/**
 * import_completed event.
 */
interface ImportCompletedEvent extends BaseSyncEvent {
  type: "import_completed";
  importId: string;
  imported: number;
  skipped: number;
  failed: number;
  total: number;
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
  event: SyncEvent,
  collections?: Collections | null
): void {
  switch (event.type) {
    case "new_entry":
      // Update unread counts without invalidating entries.list
      if (event.feedType) {
        handleNewEntry(utils, event.subscriptionId, event.feedType, queryClient, collections);
      }
      break;

    case "entry_updated": {
      // Update entry metadata in entries.get cache (detail view)
      const metadata = {
        title: event.metadata.title,
        author: event.metadata.author,
        summary: event.metadata.summary,
        url: event.metadata.url,
        publishedAt: event.metadata.publishedAt ? new Date(event.metadata.publishedAt) : null,
      };
      utils.entries.get.setData({ id: event.entryId }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          entry: {
            ...oldData.entry,
            ...(metadata.title !== undefined && { title: metadata.title }),
            ...(metadata.author !== undefined && { author: metadata.author }),
            ...(metadata.summary !== undefined && { summary: metadata.summary }),
            ...(metadata.url !== undefined && { url: metadata.url }),
            ...(metadata.publishedAt !== undefined && { publishedAt: metadata.publishedAt }),
          },
        };
      });
      // Update entries collection (list view, via reactive useLiveQuery)
      updateEntryMetadataInCollection(collections ?? null, event.entryId, metadata);
      break;
    }

    case "entry_state_changed":
      // Update entries.get cache (detail view)
      utils.entries.get.setData({ id: event.entryId }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          entry: { ...oldData.entry, read: event.read, starred: event.starred },
        };
      });
      // Update entries collection (list view, via reactive useLiveQuery)
      updateEntryReadInCollection(collections ?? null, [event.entryId], event.read);
      updateEntryStarredInCollection(collections ?? null, event.entryId, event.starred);
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
        queryClient,
        collections
      );
      break;
    }

    case "subscription_deleted":
      // Check if already removed (optimistic update from same tab)
      {
        // Check both the old cache and the TanStack DB collection
        const currentData = utils.subscriptions.list.getData();
        const alreadyRemovedFromCache =
          currentData && !currentData.items.some((s) => s.id === event.subscriptionId);
        const alreadyRemovedFromCollection =
          collections && !collections.subscriptions.has(event.subscriptionId);

        if (!alreadyRemovedFromCache || !alreadyRemovedFromCollection) {
          handleSubscriptionDeleted(utils, event.subscriptionId, queryClient, collections);
        }
      }
      break;

    case "tag_created":
      applySyncTagChanges(utils, [event.tag], []);
      addTagToCollection(collections ?? null, event.tag);
      break;

    case "tag_updated":
      applySyncTagChanges(utils, [], [event.tag]);
      updateTagInCollection(collections ?? null, event.tag);
      break;

    case "tag_deleted":
      removeSyncTags(utils, [event.tagId]);
      removeTagFromCollection(collections ?? null, event.tagId);
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
