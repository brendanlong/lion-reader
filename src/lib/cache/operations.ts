/**
 * Cache Operations
 *
 * Higher-level functions for cache updates that handle all the interactions
 * between different caches. These are the primary API for mutations and SSE
 * handlers - they don't need to know which low-level caches to update.
 *
 * Operations look up entry state from cache to handle interactions correctly:
 * - Starring an unread entry affects the starred unread count
 * - Marking a starred entry read affects the starred unread count
 */

import type { QueryClient } from "@tanstack/react-query";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import { getLocalDb } from "@/lib/local-db/local-db";
import {
  patchLiveSubscription,
  removeLiveSubscriptions,
  writeLiveSubscriptions,
  sidebarSectionOf,
  type SubscriptionListInput,
  type SubscriptionRow,
} from "@/lib/local-db/subscriptions";
import { UNCATEGORIZED_SECTION } from "@/lib/sidebar-sections";
import { insertIntoCollectionLists, setLeftCollectionLists } from "@/lib/local-db/entry-lists";

/** A subscription as the server returns it. */
export type SubscriptionData = SubscriptionRow;

/**
 * Drops a deleted subscription's `subscriptions.get` data, which the sidebar
 * would otherwise keep listing while its page is open. Run once the server has
 * deleted it: the reset refetches (now NOT_FOUND) any open page.
 */
export function forgetDeletedSubscription(utils: TRPCClientUtils, subscriptionId: string): void {
  void utils.subscriptions.get.reset({ id: subscriptionId });
}

/**
 * Removes a subscription from the local store, and so from the sidebar,
 * without touching unread counts. Used for the optimistic unsubscribe in
 * onMutate, where the server-absolute counts are applied later in onSuccess.
 */
export function removeSubscriptionFromCaches(
  subscriptionId: string,
  queryClient: QueryClient
): void {
  removeLiveSubscriptions(getLocalDb(queryClient).subscriptions, [subscriptionId]);
}

/**
 * Applies the unread-count side of a subscription_created/deleted event.
 *
 * On the live mutation/SSE path the server provides absolute `counts`, which we
 * set directly (idempotent). The sync.events catch-up path can't always compute
 * them (a deleted subscription's tag associations are already gone server-side),
 * so it omits `counts` and we invalidate the two count caches instead — a single
 * refetch, only on reconnect catch-up, never on the live path.
 */
function applySubscriptionCounts(
  utils: TRPCClientUtils,
  counts: EntryRelatedCounts | undefined,
  queryClient: QueryClient
): void {
  if (counts) {
    setEntryRelatedCounts(utils, counts, queryClient);
  } else {
    utils.tags.list.invalidate();
    utils.entries.count.invalidate();
  }
}

/**
 * Handles a new subscription being created: adds it to the local store (and so
 * to the sidebar) and applies the counts.
 *
 * @param utils - tRPC utils for cache access
 * @param subscription - The new subscription data
 * @param queryClient - React Query client for targeted invalidations
 * @param counts - Absolute unread counts for the affected lists. Present on the
 *   live mutation/SSE path; absent on the sync.events catch-up path (the client
 *   then invalidates the count caches instead).
 */
export function handleSubscriptionCreated(
  utils: TRPCClientUtils,
  subscription: SubscriptionData,
  queryClient: QueryClient,
  counts?: EntryRelatedCounts
): void {
  const store = getLocalDb(queryClient).subscriptions;
  // Guard against duplicate subscription events (e.g. the subscribing tab gets
  // both the mutation response and the SSE event): the second would write the
  // creation-time count over a newer one (#680).
  if (store.rows.getSynced(subscription.id)) return;

  // The sidebar sections render from the store, so this is all it takes to list it.
  writeLiveSubscriptions(store, [subscription]);
  if (subscription.type === "collection") {
    void utils.subscriptions.list.invalidate({ type: "collection" });
  }

  applySubscriptionCounts(utils, counts, queryClient);
}

/**
 * Applies articles being added to or removed from a collection: the absolute
 * counts, each article's cached `collections.listForEntry`, and the
 * collection's loaded entry lists. Idempotent, so the acting tab can apply
 * both its mutation response and the SSE event.
 */
export function applyCollectionEntriesChange(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  change: {
    subscriptionId: string;
    entryIds: string[];
    added: boolean;
    counts?: EntryRelatedCounts;
  }
): void {
  const { subscriptionId, entryIds, added, counts } = change;
  if (counts) setEntryRelatedCounts(utils, counts, queryClient);
  const db = getLocalDb(queryClient);
  for (const entryId of entryIds) {
    const old = utils.collections.listForEntry.getData({ entryId });
    if (old) {
      const others = old.collectionIds.filter((id) => id !== subscriptionId);
      utils.collections.listForEntry.setData(
        { entryId },
        { collectionIds: added ? [...others, subscriptionId] : others }
      );
    } else {
      // Not loaded (or failed): the rest of its membership is unknown.
      void utils.collections.listForEntry.invalidate({ entryId });
    }
    setLeftCollectionLists(db.lists, entryId, subscriptionId, !added);
    if (added) {
      const stored = db.entries.getSynced(entryId);
      if (stored) insertIntoCollectionLists(db.lists, stored, subscriptionId);
    }
  }
}

/**
 * Handles a subscription being deleted: removes it from the local store,
 * applies the counts, and invalidates `entries.list` (its entries drop out).
 *
 * @param utils - tRPC utils for cache access
 * @param subscriptionId - ID of the deleted subscription
 * @param queryClient - React Query client for targeted invalidations
 * @param counts - Absolute unread counts for the affected lists. Present on the
 *   live mutation/SSE path; absent on the sync.events catch-up path (the server
 *   can't recompute the former tags there), in which case the client
 *   invalidates the count caches instead.
 */
export function handleSubscriptionDeleted(
  utils: TRPCClientUtils,
  subscriptionId: string,
  queryClient: QueryClient,
  counts?: EntryRelatedCounts
): void {
  // Run whether or not the store holds it: an optimistic unsubscribe already
  // removed it, or it was never loaded (its tag collapsed), and the counts and
  // entries below still changed (#1081).
  removeSubscriptionFromCaches(subscriptionId, queryClient);

  applySubscriptionCounts(utils, counts, queryClient);

  // A deleted collection no longer holds anything.
  queryClient.setQueriesData<{ collectionIds: string[] }>(
    { queryKey: [["collections", "listForEntry"]] },
    (old) => old && { collectionIds: old.collectionIds.filter((id) => id !== subscriptionId) }
  );
  forgetDeletedSubscription(utils, subscriptionId);

  // Always invalidate entries.list - entries from this subscription should be filtered out
  utils.entries.list.invalidate();
}

// ============================================================================
// Absolute Count Updates (Server-Provided Counts)
// ============================================================================

/**
 * Bulk unread counts, as returned by the markRead and setStarred mutations.
 */
export interface BulkUnreadCounts {
  all: { unread: number };
  starred: { unread: number };
  saved: { unread: number };
  /** `tagIds` is absent from events a previous release published. */
  subscriptions: Array<{ id: string; unread: number; tagIds?: string[] }>;
  tags: Array<{ id: string; unread: number }>;
  uncategorized?: { unread: number };
}

/**
 * Sets absolute counts from an entry mutation response (markRead, setStarred)
 * or a count-bearing realtime event. `saved` is optional: the server always
 * provides it, but events from a previous release may omit it (web/email
 * entries), in which case the write is skipped.
 *
 * @param utils - tRPC utils for cache access
 * @param counts - Absolute counts from server (saved optional)
 * @param queryClient - React Query client for updating infinite query caches
 */
export function setBulkCounts(
  utils: TRPCClientUtils,
  counts: EntryRelatedCounts,
  queryClient: QueryClient
): void {
  // Set global counts
  utils.entries.count.setData({}, counts.all);
  utils.entries.count.setData({ starredOnly: true }, counts.starred);
  // Only write the saved count when we actually have one. Events that omit it
  // (web/email) and an empty cache leave it undefined; writing a fabricated
  // { unread: 0 } would seed a "fresh" saved count that a later mount trusts.
  if (counts.saved) {
    utils.entries.count.setData({ type: "saved" }, counts.saved);
  }

  setSubscriptionUnreadCounts(utils, queryClient, counts.subscriptions);

  // Set tag unread counts
  for (const tag of counts.tags) {
    setTagUnreadCount(utils, tag.id, tag.unread);
  }

  // Set uncategorized count
  if (counts.uncategorized) {
    setUncategorizedUnreadCount(utils, counts.uncategorized.unread);
  }
}

/**
 * Counts carried by count-bearing realtime events (new_entry,
 * entry_state_changed). Same shape as BulkUnreadCounts but `saved` is optional,
 * since a previous release omitted it from web/email events.
 */
export type EntryRelatedCounts = Omit<BulkUnreadCounts, "saved"> & {
  saved?: { unread: number };
};

/**
 * Applies absolute unread counts from a count-bearing realtime event.
 *
 * Fills in `saved` from the current cache when the event omits it (events
 * from a previous release didn't compute it for web/email entries) so setBulkCounts doesn't clobber the
 * client's existing saved count with a wrong value. Because every value is set
 * absolutely, applying the same event twice — e.g. once from the live SSE
 * stream and once from a reconnect catch-up sync — leaves counts correct.
 *
 * @param utils - tRPC utils for cache access
 * @param counts - Absolute counts from the server (saved optional)
 * @param queryClient - React Query client for updating infinite query caches
 */
export function setEntryRelatedCounts(
  utils: TRPCClientUtils,
  counts: EntryRelatedCounts,
  queryClient: QueryClient
): void {
  // Fill in `saved` from the current cache when the event omits it so
  // setBulkCounts doesn't clobber an existing saved count. If neither the event
  // nor the cache has a value, leave it undefined — setBulkCounts then skips the
  // write rather than fabricating a { unread: 0 } that a later mount serves as
  // fresh.
  const currentSaved = utils.entries.count.getData({ type: "saved" });
  setBulkCounts(utils, { ...counts, saved: counts.saved ?? currentSaved }, queryClient);
}

/**
 * Sets stored subscriptions' unread counts. A subscription the store lacks
 * that now has unread entries is loaded (`loadSubscriptionForSidebar`), so an
 * unread-only sidebar section that hid it can list it.
 */
function setSubscriptionUnreadCounts(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  subscriptions: BulkUnreadCounts["subscriptions"]
): void {
  const store = getLocalDb(queryClient).subscriptions;
  for (const { id, unread, tagIds } of subscriptions) {
    const row = store.rows.getSynced(id);
    if (row) {
      if (row.unreadCount !== unread) patchLiveSubscription(store, id, { unreadCount: unread });
    } else if (unread > 0) {
      loadSubscriptionForSidebar(utils, queryClient, id, tagIds);
    }
  }
}

/**
 * Fetches a subscription the store lacks into it, when a loaded sidebar
 * section may list it: one with these tags (unknown tags count as maybe).
 * One that only collapsed tags would list isn't fetched; expanding them loads it.
 */
export function loadSubscriptionForSidebar(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  id: string,
  tagIds: string[] | undefined
): void {
  if (tagIds && !isSidebarSectionLoaded(queryClient, tagIds)) return;
  utils.subscriptions.get.fetch({ id }, { staleTime: 0 }).catch(() => {
    // Gone already, or offline: nothing to list.
  });
}

function isSidebarSectionLoaded(queryClient: QueryClient, tagIds: string[]): boolean {
  return queryClient
    .getQueriesData({ queryKey: [["subscriptions", "list"]] })
    .some(([queryKey]) => {
      const input = (queryKey[1] as { input?: SubscriptionListInput } | undefined)?.input;
      const section = input && sidebarSectionOf(input);
      if (section === undefined) return false;
      return section === UNCATEGORIZED_SECTION ? tagIds.length === 0 : tagIds.includes(section);
    });
}

/**
 * Sets the unread count for a specific tag.
 */
function setTagUnreadCount(utils: TRPCClientUtils, tagId: string, unread: number): void {
  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      items: oldData.items.map((tag) => (tag.id === tagId ? { ...tag, unreadCount: unread } : tag)),
    };
  });
}

/**
 * Sets the uncategorized unread count.
 */
function setUncategorizedUnreadCount(utils: TRPCClientUtils, unread: number): void {
  utils.tags.list.setData(undefined, (oldData) => {
    if (!oldData) return oldData;
    return {
      ...oldData,
      uncategorized: {
        ...oldData.uncategorized,
        unreadCount: unread,
      },
    };
  });
}
