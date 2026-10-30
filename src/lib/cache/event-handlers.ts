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
  applyNewEntry,
  applySubscriptionUpdate,
  handleSubscriptionCreated,
  handleSubscriptionDeleted,
  handleMarkAllRead,
  applyTagChange,
  applyTagDeleted,
  applyUnreadCounts,
  toEntryRow,
} from "./operations";
import { patchServerEntryMetadata } from "@/lib/local-db/entries";
import { getLocalDb } from "@/lib/local-db/local-db";
import { setLiveAnnouncement } from "@/lib/site-status/announcement-store";

// Re-export SyncEvent type from the shared schema (single source of truth)
import type { SyncEvent, SyncSubscription } from "@/lib/events/schemas";
import type { StampedSubscriptionRow } from "@/lib/local-db/subscriptions";
export type { SyncEvent } from "@/lib/events/schemas";

function toSubscriptionRow(subscription: SyncSubscription): StampedSubscriptionRow {
  return { ...subscription, subscribedAt: new Date(subscription.subscribedAt) };
}

/**
 * Loads a subscription whose event came without its row (from a previous
 * release, during a deploy) into the store.
 */
function fetchSubscription(utils: TRPCClientUtils, id: string): void {
  utils.subscriptions.get.fetch({ id }, { staleTime: 0 }).catch(() => {
    // Gone already, or offline: the next list refresh settles it.
  });
}

/**
 * Whether a replayed event may move an entry into or out of a collection: an
 * `entry_state_changed` whose memberships differ from the stored entry's, or
 * for an entry the store lacks. Its counts cover only the collections the
 * entry is in now, not one it left. Check it before applying the event.
 */
export function mayChangeMemberships(queryClient: QueryClient, event: SyncEvent): boolean {
  if (event.type !== "entry_state_changed") return false;
  const stored = getLocalDb(queryClient).entries.getSynced(event.entryId);
  if (!stored) return true;
  const before = new Set(stored.subscriptionIds);
  return (
    before.size !== event.subscriptionIds.length ||
    event.subscriptionIds.some((id) => !before.has(id))
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
      // re-delivered by a reconnect catch-up sync can't double-count). The
      // server omits them when it failed to read them; they self-heal on the
      // next count-bearing event or refetch.
      // Spam has no payload: the default entries.list filters it out.
      applyNewEntry(
        utils,
        queryClient,
        event.entry && { ...event, entry: event.entry },
        event.counts
      );
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
      const state = { read: event.read, starred: event.starred };
      // A server a release behind sends neither: keep what's stored.
      const stored = getLocalDb(queryClient).entries.getSynced(event.entryId);
      const ranks = {
        score: event.score !== undefined ? event.score : (stored?.score ?? null),
        positions: event.positions ?? stored?.positions ?? {},
      };
      applyEntryStateChanges(utils, queryClient, {
        entries: [
          {
            id: event.entryId,
            ...state,
            subscriptionIds: event.subscriptionIds,
            tagLists: event.tagLists,
            ...(event.positions && { positions: event.positions }),
            ...(event.score !== undefined && { score: event.score }),
            updatedAt: new Date(event.updatedAt),
            // Sent with an unread flip; star/unstar of an unread entry falls
            // back to the stored row.
            ...(event.entry && {
              listItem: toEntryRow({ ...event, ...ranks }, event.entry, state),
            }),
          },
        ],
        counts: event.counts,
      });
      break;
    }

    case "mark_all_read":
      // One of the two SSE events that deliberately refetch entries.list: the
      // user is done with the list, so refetching it is an acceptable, rare cost.
      handleMarkAllRead(utils, queryClient, event.counts);
      break;

    case "subscription_created":
      if (event.row) {
        handleSubscriptionCreated(utils, toSubscriptionRow(event.row), queryClient, event.counts);
      } else {
        fetchSubscription(utils, event.subscriptionId);
        if (event.counts) applyUnreadCounts(utils, queryClient, event.counts);
      }
      break;

    case "subscription_updated":
      if (event.row) {
        applySubscriptionUpdate(utils, queryClient, toSubscriptionRow(event.row));
      } else {
        fetchSubscription(utils, event.subscriptionId);
      }
      break;

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
      applyCollectionEntriesChange(utils, queryClient, {
        ...event,
        updatedAt: new Date(event.updatedAt),
      });
      break;

    case "tag_created":
      applyTagChange(queryClient, event.tag);
      break;

    case "tag_updated":
      applyTagChange(queryClient, event.tag);
      break;

    case "tag_deleted":
      applyTagDeleted(utils, queryClient, event.tagId);
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
