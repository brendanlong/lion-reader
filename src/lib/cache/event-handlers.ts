/**
 * Shared Event Handlers
 *
 * Provides unified event handling for both SSE and sync endpoints.
 * Both SSE real-time events and sync polling use the same event types,
 * so we can share the cache update logic between them.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import { handleSubscriptionCreated, handleSubscriptionDeleted, handleNewEntry } from "./operations";
import { updateEntriesInListCache, updateEntryMetadataInCache } from "./entry-cache";
import { applySyncTagChanges, removeSyncTags, updateSubscriptionInCache } from "./count-cache";

// Re-export SyncEvent type from the shared schema (single source of truth)
import type { SyncEvent } from "@/lib/events/schemas";
export type { SyncEvent } from "@/lib/events/schemas";

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

    case "subscription_updated":
      // Update the subscription's tags and title in cache, then invalidate
      // tag-related queries to get fresh feedCount/unreadCount
      updateSubscriptionInCache(utils, event.subscriptionId, {
        tags: event.tags,
        ...(event.customTitle !== null ? { title: event.customTitle } : {}),
      });
      utils.tags.list.invalidate();
      utils.subscriptions.list.invalidate();
      break;

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
