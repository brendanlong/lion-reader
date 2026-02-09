/**
 * Shared Event Handlers
 *
 * Provides unified event handling for both SSE and sync endpoints.
 * Both SSE real-time events and sync polling use the same event types,
 * so we can share the cache update logic between them.
 *
 * State updates flow through TanStack DB collections for sidebar/list views.
 * React Query entries.get is still updated for the detail view.
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";
import type { Collections } from "@/lib/collections";
import { handleSubscriptionCreated, handleSubscriptionDeleted, handleNewEntry } from "./operations";
import {
  addTagToCollection,
  updateTagInCollection,
  removeTagFromCollection,
  updateEntryReadInCollection,
  updateEntryStarredInCollection,
  updateEntryMetadataInCollection,
} from "@/lib/collections/writes";

// Re-export SyncEvent type from the shared schema
export type { SyncEvent } from "@/lib/events/schemas";
import type { SyncEvent } from "@/lib/events/schemas";

// ============================================================================
// Event Handler
// ============================================================================

/**
 * Handles a sync event by updating the appropriate caches and collections.
 *
 * This is the unified event handler used by both SSE and sync endpoints.
 * It dispatches to the appropriate update functions based on event type.
 *
 * @param utils - tRPC utils for entries.get cache and invalidation
 * @param event - The event to handle
 * @param collections - TanStack DB collections for state updates
 */
export function handleSyncEvent(
  utils: TRPCClientUtils,
  event: SyncEvent,
  collections?: Collections | null
): void {
  switch (event.type) {
    case "new_entry":
      // Update unread counts in collections
      if (event.feedType) {
        handleNewEntry(utils, event.subscriptionId, event.feedType, collections);
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
        collections
      );
      break;
    }

    case "subscription_deleted":
      // Check if already removed (optimistic update from same tab)
      {
        const alreadyRemoved = collections && !collections.subscriptions.has(event.subscriptionId);

        if (!alreadyRemoved) {
          handleSubscriptionDeleted(utils, event.subscriptionId, collections);
        }
      }
      break;

    case "tag_created":
      addTagToCollection(collections ?? null, event.tag);
      break;

    case "tag_updated":
      updateTagInCollection(collections ?? null, event.tag);
      break;

    case "tag_deleted":
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
