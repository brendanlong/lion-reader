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
  applyCollectionEntriesChange,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  loadSubscriptionForSidebar,
  setEntryRelatedCounts,
} from "./operations";
import {
  patchServerEntryMetadata,
  setServerEntryState,
  type EntryRow,
} from "@/lib/local-db/entries";
import { addServerEntryToLists, getLocalDb, insertEntryIntoLists } from "@/lib/local-db/local-db";
import { applySyncTagChanges, removeSyncTags } from "./tag-cache";
import { patchLiveSubscription } from "@/lib/local-db/subscriptions";
import { setLiveAnnouncement } from "@/lib/site-status/announcement-store";

// Re-export SyncEvent type from the shared schema (single source of truth)
import type { NewEntryListData, SyncEvent } from "@/lib/events/schemas";
export type { SyncEvent } from "@/lib/events/schemas";

/** Builds the entry row for an event's list-item payload. */
function toEntryRow(
  event: { entryId: string; subscriptionId?: string | null; updatedAt: string },
  feedId: string,
  type: EntryRow["type"],
  entry: NewEntryListData,
  state: { read: boolean; starred: boolean }
): EntryRow {
  return {
    id: event.entryId,
    subscriptionId: event.subscriptionId ?? null,
    feedId,
    type,
    url: entry.url,
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : null,
    fetchedAt: new Date(entry.fetchedAt),
    updatedAt: new Date(event.updatedAt),
    read: state.read,
    starred: state.starred,
    feedTitle: entry.feedTitle,
    siteName: entry.siteName,
  };
}

// ============================================================================
// Event Handler
// ============================================================================

/**
 * Handles a sync event by updating the local entry store and the React Query
 * caches.
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
  const db = getLocalDb(queryClient);
  switch (event.type) {
    case "new_entry":
      // Set absolute unread counts from the server (idempotent — a new_entry
      // re-delivered by a reconnect catch-up sync can't double-count). Older
      // servers may omit counts during a deploy; skip the update then and let
      // it self-heal on the next count-bearing event or refetch.
      if (event.counts) {
        setEntryRelatedCounts(utils, event.counts, queryClient);
      }

      // Insert the entry into loaded lists so it appears live (deduped, so
      // SSE + catch-up double delivery is safe). Older servers omit the entry
      // payload during a deploy; the entry then appears on the next
      // navigation-triggered list refresh instead. read/starred are set only
      // by the catch-up sync path (the entry may have changed state on
      // another device while this client was offline); the live path omits
      // them because a brand-new entry is always unread/unstarred.
      if (event.entry && event.feedId) {
        addServerEntryToLists(
          db,
          queryClient,
          toEntryRow(event, event.feedId, event.feedType, event.entry, {
            read: event.entry.read ?? false,
            starred: event.entry.starred ?? false,
          })
        );
      }
      break;

    case "entry_updated":
      patchServerEntryMetadata(
        db.entries,
        event.entryId,
        {
          ...event.metadata,
          publishedAt: event.metadata.publishedAt ? new Date(event.metadata.publishedAt) : null,
        },
        new Date(event.updatedAt)
      );
      break;

    case "entry_state_changed": {
      const state = { read: event.read, starred: event.starred };
      setServerEntryState(db.entries, event.entryId, {
        ...state,
        updatedAt: new Date(event.updatedAt),
      });

      // An entry that became unread (here or on another device) belongs in
      // unread-only lists that don't contain it (fetched while it was read).
      // Prefer the event's list-item payload — it lets the entry appear even
      // when the store doesn't hold it (e.g. marked unread on another device
      // or via MCP), the same way new_entry payloads make new entries appear
      // live (issue #1237). Events without a payload (older servers,
      // star/unstar of an unread entry) fall back to the stored row.
      if (!event.read) {
        if (event.entry && event.feedId && event.feedType) {
          addServerEntryToLists(
            db,
            queryClient,
            toEntryRow(event, event.feedId, event.feedType, event.entry, state)
          );
        } else {
          const stored = db.entries.getSynced(event.entryId);
          if (stored) insertEntryIntoLists(db, queryClient, stored);
        }
      }

      // Set all counts from the server directly — no delta estimation needed.
      setEntryRelatedCounts(utils, event.counts, queryClient);
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
      utils.subscriptions.get.invalidate();
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
      // The stored row moves between sidebar sections with its tags. A
      // cleared custom title falls back to the feed's own, which the row has.
      const stored = db.subscriptions.rows.getSynced(event.subscriptionId);
      if (stored) {
        patchLiveSubscription(db.subscriptions, event.subscriptionId, {
          tags: event.tags,
          title: event.customTitle ?? stored.originalTitle,
        });
      } else {
        const tagIds = event.tags.map((tag) => tag.id);
        loadSubscriptionForSidebar(utils, queryClient, event.subscriptionId, tagIds);
      }
      // Tag feed counts changed.
      utils.tags.list.invalidate();
      break;
    }

    case "subscription_deleted":
      // handleSubscriptionDeleted is idempotent: it skips the structural removal
      // when the subscription is already gone from cache (optimistic same-tab
      // delete, or a never-cached subscription) but still applies the absolute
      // counts and invalidates entries.list. Calling it unconditionally fixes
      // the case where a delete for a never-cached subscription (common with
      // tags collapsed) left inflated counts and stale entries (#1081).
      handleSubscriptionDeleted(utils, event.subscriptionId, queryClient, event.counts);
      break;

    case "collection_entries_changed":
      applyCollectionEntriesChange(utils, queryClient, event);
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

    case "announcement_changed":
      // Global banner change — update the module store the root-layout banner
      // subscribes to. No React Query cache is involved (the banner isn't a
      // query); null clears it.
      setLiveAnnouncement(event.announcement);
      break;
  }
}
