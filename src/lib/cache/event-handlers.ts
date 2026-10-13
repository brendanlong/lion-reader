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
  applyEntryStateChanges,
  applySubscriptionUpdate,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  handleMarkAllRead,
  setEntryRelatedCounts,
} from "./operations";
import { patchServerEntryMetadata, type EntryRow } from "@/lib/local-db/entries";
import {
  addServerEntryToLists,
  getLocalDb,
  insertEntryIntoLists,
  type LocalDb,
} from "@/lib/local-db/local-db";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";
import { applySyncTagChanges, removeSyncTags } from "./tag-cache";
import { setLiveAnnouncement } from "@/lib/site-status/announcement-store";

// Re-export SyncEvent type from the shared schema (single source of truth)
import type { NewEntryListData, SyncEvent } from "@/lib/events/schemas";
export type { SyncEvent } from "@/lib/events/schemas";

/**
 * Builds the entry row for an event's list-item payload. A previous release's
 * events carry no `subscriptionIds` (a new entry's one membership is then its
 * origin) and no payload `type` (the event's `feedType` stands in).
 */
function toEntryRow(
  event: {
    entryId: string;
    subscriptionId?: string | null;
    subscriptionIds?: string[];
    feedType: EntryRow["type"];
    updatedAt: string;
  },
  entry: NewEntryListData,
  state: { read: boolean; starred: boolean }
): EntryRow {
  const subscriptionId = event.subscriptionId ?? null;
  return {
    id: event.entryId,
    subscriptionId,
    subscriptionIds: event.subscriptionIds ?? (subscriptionId ? [subscriptionId] : []),
    type: entry.type ?? event.feedType,
    url: entry.url,
    title: entry.title,
    author: entry.author,
    summary: entry.summary,
    publishedAt: entry.publishedAt ? new Date(entry.publishedAt) : null,
    fetchedAt: new Date(entry.fetchedAt),
    updatedAt: new Date(event.updatedAt),
    ...(entry.entryUpdatedAt && { entryUpdatedAt: new Date(entry.entryUpdatedAt) }),
    read: state.read,
    starred: state.starred,
    feedTitle: entry.feedTitle,
    siteName: entry.siteName,
  };
}

/**
 * A saved article arrived while the client knows of no saved subscription:
 * this save created it (the user's first), so look its id up, then place the
 * entry. Keyed on the entry's type, the one thing a first save's event surely
 * says (it may be read already, so its counts needn't show it), and done at
 * most once per page load, so a server answering null can't make every save
 * refetch.
 */
function learnNewSavedSubscription(utils: TRPCClientUtils, db: LocalDb, entry: EntryRow): void {
  if (entry.type !== "saved" || db.saved.id !== null || db.saved.lookedUp) return;
  db.saved.lookedUp = true;
  // The cached null is still fresh by the staleTime, but out of date now.
  void utils.subscriptions.list.fetch(SAVED_SUBSCRIPTION_LIST_INPUT, { staleTime: 0 }).then(
    () => {
      const stored = db.entries.getSynced(entry.id);
      if (stored) insertEntryIntoLists(db, stored);
    },
    () => {
      // Lists pick the entry up on their next refresh.
    }
  );
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
      if (event.entry) {
        const row = toEntryRow(event, event.entry, {
          read: event.entry.read ?? false,
          starred: event.entry.starred ?? false,
        });
        addServerEntryToLists(db, row);
        learnNewSavedSubscription(utils, db, row);
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
        new Date(event.entryUpdatedAt ?? event.updatedAt)
      );
      break;

    case "entry_state_changed": {
      const feedType = event.entry?.type ?? event.feedType;
      const state = { read: event.read, starred: event.starred };
      applyEntryStateChanges(utils, queryClient, {
        entries: [
          {
            id: event.entryId,
            ...state,
            subscriptionIds: event.subscriptionIds,
            updatedAt: new Date(event.updatedAt),
            // Sent with an unread flip; older servers and star/unstar of an
            // unread entry fall back to the stored row.
            ...(event.entry &&
              feedType && {
                listItem: toEntryRow({ ...event, feedType }, event.entry, state),
              }),
          },
        ],
        counts: event.counts,
      });
      break;
    }

    case "mark_all_read":
      // The one SSE event that deliberately refetches entries.list: the user
      // is done with the list, so refetching it is an acceptable, rare cost.
      handleMarkAllRead(utils, queryClient, event.counts);
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
      // A cleared custom title falls back to the feed's own, which only a
      // stored row knows.
      const stored = db.subscriptions.rows.getSynced(event.subscriptionId);
      applySubscriptionUpdate(utils, queryClient, {
        id: event.subscriptionId,
        tags: event.tags,
        title: event.customTitle ?? stored?.originalTitle,
        fetchFullContent: event.fetchFullContent,
      });
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

    default: {
      // A new event type without a case here fails to compile.
      const unhandled: never = event;
      void unhandled;
    }
  }
}
