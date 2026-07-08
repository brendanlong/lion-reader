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
  setEntryRelatedCounts,
} from "./operations";
import {
  insertEntryIntoListCaches,
  restoreUnreadEntriesToListCaches,
  updateEntriesInListCache,
  updateEntryMetadataInCache,
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
      // Set absolute unread counts from the server (idempotent — a new_entry
      // re-delivered by a reconnect catch-up sync can't double-count). Older
      // servers may omit counts during a deploy; skip the update then and let
      // it self-heal on the next count-bearing event or refetch.
      if (event.counts) {
        setEntryRelatedCounts(utils, event.counts, queryClient);
      }

      // Insert the entry into cached lists so it appears live (deduped, so
      // SSE + catch-up double delivery is safe). Older servers omit the entry
      // payload during a deploy; the entry then appears on the next
      // navigation-triggered list refresh instead. read/starred are set only
      // by the catch-up sync path (the entry may have changed state on
      // another device while this client was offline); the live path omits
      // them because a brand-new entry is always unread/unstarred.
      if (event.entry && event.feedId) {
        insertEntryIntoListCaches(queryClient, {
          id: event.entryId,
          subscriptionId: event.subscriptionId,
          feedId: event.feedId,
          type: event.feedType,
          url: event.entry.url,
          title: event.entry.title,
          author: event.entry.author,
          summary: event.entry.summary,
          publishedAt: event.entry.publishedAt ? new Date(event.entry.publishedAt) : null,
          fetchedAt: new Date(event.entry.fetchedAt),
          updatedAt: new Date(event.updatedAt),
          read: event.entry.read ?? false,
          starred: event.entry.starred ?? false,
          feedTitle: event.entry.feedTitle,
          siteName: event.entry.siteName,
        });
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

    case "entry_state_changed": {
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

      // An entry that became unread (here or on another device) belongs in
      // unreadOnly caches that don't contain it (fetched while it was read);
      // the in-place update above can't add rows.
      if (!event.read) {
        restoreUnreadEntriesToListCaches(queryClient, [event.entryId]);
      }

      // Set all counts from the server directly — no delta estimation needed.
      // A count-less event (from a compat route that skipped the aggregation)
      // still applied the read/starred state above; badge totals self-heal on
      // the next count-bearing event or refetch.
      if (event.counts) {
        setEntryRelatedCounts(utils, event.counts, queryClient);
      }
      break;
    }

    case "mark_all_read":
      // Mark-all-read on another tab/device. Mark-all-read is unbounded, so
      // rather than patch (potentially thousands of) entries, we invalidate the
      // entry lists + counts — mirroring what the acting tab does on success
      // (useEntryMutations.markAllRead), just broader: the event carries no
      // filter, so we invalidate every entries.count variant rather than the
      // specific ones the acting tab knows were affected. This is the one SSE
      // event that deliberately refetches entries.list: the whole point of
      // mark-all-read is that the user is done with the list, so a refetch of a
      // list they've cleared is an acceptable, rare cost. Counts refetch to
      // their new values.
      utils.entries.list.invalidate();
      utils.entries.count.invalidate();
      utils.tags.list.invalidate();
      utils.subscriptions.list.invalidate();
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
        event.counts
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
          handleSubscriptionDeleted(utils, event.subscriptionId, queryClient, event.counts);
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
