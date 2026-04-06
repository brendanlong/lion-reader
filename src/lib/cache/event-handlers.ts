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
  handleEntriesMarkedRead,
  handleEntryStarred,
  handleEntryUnstarred,
  setBulkCounts,
} from "./operations";
import {
  updateEntriesInListCache,
  updateEntryMetadataInCache,
  findEntryInListCache,
} from "./entry-cache";
import {
  applySyncTagChanges,
  removeSyncTags,
  updateSubscriptionInCache,
  findCachedSubscription,
  type CachedSubscription,
} from "./count-cache";

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
      handleNewEntry(utils, event.subscriptionId, event.feedType, queryClient);
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

    case "entry_state_changed": {
      // Snapshot previous state from list cache BEFORE updating, needed for
      // the delta-based fallback path (sync polling without counts).
      const listEntry = !event.counts
        ? findEntryInListCache(queryClient, event.entryId)
        : undefined;

      // Update entries.get and entries.list caches with new read/starred state
      utils.entries.get.setData({ id: event.entryId }, (oldData) => {
        if (!oldData) return oldData;
        return {
          ...oldData,
          entry: { ...oldData.entry, read: event.read, starred: event.starred },
        };
      });
      updateEntriesInListCache(queryClient, [event.entryId], {
        read: event.read,
        starred: event.starred,
      });

      // Update unread counts.
      // When the server provides absolute counts, use them directly — no
      // delta estimation, no dependency on cached state. This is the primary
      // path for SSE events from markRead/setStarred mutations.
      if (event.counts) {
        // Set all counts. Use a placeholder for saved if not provided
        // (non-saved entry mutations don't compute saved count) to avoid
        // overwriting the client's current saved count with a wrong value.
        const currentSaved = utils.entries.count.getData({ type: "saved" });
        setBulkCounts(
          utils,
          { ...event.counts, saved: event.counts.saved ?? currentSaved ?? { unread: 0 } },
          queryClient
        );
      } else if (listEntry) {
        // Fallback for sync polling events (which don't include counts).
        // Uses cached previous state from the list to compute deltas.
        // Only works when the entry was in the list cache.
        if (listEntry.read !== event.read) {
          handleEntriesMarkedRead(
            utils,
            [
              {
                id: event.entryId,
                subscriptionId: listEntry.subscriptionId,
                starred: listEntry.starred,
                type: listEntry.type,
              },
            ],
            event.read,
            queryClient
          );
        }

        if (listEntry.starred !== event.starred) {
          if (event.starred) {
            handleEntryStarred(utils, event.entryId, event.read, queryClient);
          } else {
            handleEntryUnstarred(utils, event.entryId, event.read, queryClient);
          }
        }
      }
      break;
    }

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

    case "subscription_updated": {
      // Update the subscription's tags and title in cache, then invalidate
      // tag-related queries to get fresh feedCount/unreadCount
      const subUpdates: Partial<Pick<CachedSubscription, "tags" | "title">> = {
        tags: event.tags,
      };
      if (event.customTitle !== null) {
        // Custom title set - use it as the resolved title
        subUpdates.title = event.customTitle;
      } else {
        // Custom title cleared - revert to originalTitle from cache
        const cached = utils.subscriptions.get.getData({ id: event.subscriptionId });
        if (cached) {
          subUpdates.title = cached.originalTitle;
        }
        // If not cached, the invalidation below will correct it
      }
      updateSubscriptionInCache(utils, event.subscriptionId, subUpdates);
      utils.tags.list.invalidate();
      utils.subscriptions.list.invalidate();
      break;
    }

    case "subscription_deleted":
      // Check if already removed (optimistic update from same tab).
      // Check both the lookup map and infinite queries, since pre-existing
      // subscriptions may only be in the infinite query caches.
      {
        const alreadyRemoved = !findCachedSubscription(queryClient, event.subscriptionId);

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
