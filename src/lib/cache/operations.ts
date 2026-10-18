/**
 * Cache Operations
 *
 * One function per server-reported change, shared by the mutation response
 * and the realtime event that report it, so the two can't drift. They write
 * the local store (`src/lib/local-db/`); React Query caches are only
 * invalidated, never patched.
 */

import type { QueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import type { unreadCountsSchema } from "@/lib/events/schemas";
import type { TRPCClientUtils } from "@/lib/trpc/client";
import { addServerEntryToLists, getLocalDb, insertEntryIntoLists } from "@/lib/local-db/local-db";
import {
  removeStoredEntryMemberships,
  setServerEntryState,
  setStoredEntryCollection,
  setSubscriptionEntriesFeedTitle,
  type EntryRow,
} from "@/lib/local-db/entries";
import { removeTagCount, writeCounts } from "@/lib/local-db/counts";
import { removeLiveTag, writeLiveTag, type TagRow } from "@/lib/local-db/tags";
import { removeLiveRows } from "@/lib/local-db/versioned-store";
import {
  patchLiveSubscription,
  writeLiveSubscriptions,
  writeSubscriptionCount,
  sidebarSectionOf,
  type SubscriptionListInput,
  type SubscriptionRow,
} from "@/lib/local-db/subscriptions";
import { UNCATEGORIZED_SECTION } from "@/lib/sidebar-sections";
import { setLeftCollectionLists } from "@/lib/local-db/entry-lists";

/**
 * Drops a deleted subscription's `subscriptions.get` data. Run once the server
 * has deleted it: the reset refetches (now NOT_FOUND) any open page.
 */
function forgetDeletedSubscription(utils: TRPCClientUtils, subscriptionId: string): void {
  void utils.subscriptions.get.reset({ id: subscriptionId });
}

/**
 * Removes a subscription from the local store, and so from the sidebar,
 * without touching unread counts. Used for the optimistic unsubscribe in
 * onMutate, where the server-absolute counts are applied later in onSuccess.
 * Returns the removal's version (see `restoreRemovedRow`).
 */
export function removeSubscriptionFromCaches(
  subscriptionId: string,
  queryClient: QueryClient
): number {
  return removeLiveRows(getLocalDb(queryClient).subscriptions, [subscriptionId]);
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
  counts: UnreadCounts | undefined,
  queryClient: QueryClient
): void {
  if (counts) {
    applyUnreadCounts(utils, queryClient, counts);
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
  subscription: SubscriptionRow,
  queryClient: QueryClient,
  counts?: UnreadCounts
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
 * A subscription's new settings: the whole row from an update/setTags
 * response, or what a subscription_updated event carries. An undefined field
 * is unknown and left as it is.
 */
type SubscriptionUpdate = Pick<SubscriptionRow, "id" | "tags"> &
  Partial<Pick<SubscriptionRow, "title" | "fetchFullContent">>;

/**
 * Applies a subscription's new tags, title and settings, from its mutation
 * response or its event. Idempotent, so the acting tab can apply both.
 */
export function applySubscriptionUpdate(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  update: SubscriptionUpdate
): void {
  const { id, tags, title, fetchFullContent } = update;
  const db = getLocalDb(queryClient);
  const stored = db.subscriptions.rows.getSynced(id);
  // Its entries show the same title (the server sends it as their
  // feedTitle), so a rename carries over to the ones already loaded.
  if (title !== undefined) setSubscriptionEntriesFeedTitle(db.entries, id, title);
  // The reader reads the setting from the stored subscription, else from the
  // entry's copy, which only a refetch updates.
  if (!stored && fetchFullContent !== undefined && !isFullSubscriptionRow(update)) {
    void utils.entries.get.invalidate();
  }
  // The stored row moves between sidebar sections with its tags.
  if (stored) {
    patchLiveSubscription(db.subscriptions, id, {
      tags,
      ...(title !== undefined && { title }),
      ...(fetchFullContent !== undefined && { fetchFullContent }),
    });
  } else if (isFullSubscriptionRow(update)) {
    writeLiveSubscriptions(db.subscriptions, [update]);
  } else {
    loadSubscriptionForSidebar(
      utils,
      queryClient,
      id,
      tags.map((tag) => tag.id)
    );
  }
  const tagIds = (row: Pick<SubscriptionRow, "tags">) =>
    row.tags
      .map((tag) => tag.id)
      .sort()
      .join();
  // Tag feed counts change with the tags, and the collection picker searches by title.
  if (!stored || tagIds(stored) !== tagIds(update)) utils.tags.list.invalidate();
  if (!stored || (title !== undefined && title !== stored.title)) {
    void utils.subscriptions.list.invalidate({ type: "collection" });
  }
}

function isFullSubscriptionRow(update: SubscriptionUpdate): update is SubscriptionRow {
  return "originalTitle" in update;
}

/**
 * Applies a created or updated tag, from its mutation response or its event,
 * to the stored tag and to the stored subscriptions carrying it.
 */
export function applyTagChange(
  queryClient: QueryClient,
  tag: Pick<TagRow, "id" | "name" | "color"> & Partial<Pick<TagRow, "feedCount" | "createdAt">>
): void {
  const db = getLocalDb(queryClient);
  const { id, name, color } = tag;
  writeLiveTag(db.tags, {
    id,
    name,
    color,
    ...(tag.feedCount !== undefined && { feedCount: tag.feedCount }),
    ...(tag.createdAt !== undefined && { createdAt: tag.createdAt }),
  });
  for (const row of db.subscriptions.rows.allSynced()) {
    if (row.tags.some((t) => t.id === id && (t.name !== name || t.color !== color))) {
      patchLiveSubscription(db.subscriptions, row.id, {
        tags: row.tags.map((t) => (t.id === id ? { id, name, color } : t)),
      });
    }
  }
}

/**
 * Applies a deleted tag, from its mutation response or its event: removes it
 * and its count, and takes it off the stored subscriptions, which may move
 * them to Uncategorized. The event carries no counts, so `tags.list` (and with
 * it Uncategorized's count) is refetched.
 */
export function applyTagDeleted(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  tagId: string
): void {
  const db = getLocalDb(queryClient);
  removeLiveTag(db.tags, tagId);
  removeTagCount(db.counts, tagId);
  for (const row of db.subscriptions.rows.allSynced()) {
    if (row.tags.some((t) => t.id === tagId)) {
      patchLiveSubscription(db.subscriptions, row.id, {
        tags: row.tags.filter((t) => t.id !== tagId),
      });
    }
  }
  utils.tags.list.invalidate();
}

/**
 * Applies articles being added to or removed from a collection: the absolute
 * counts, each stored article's `subscriptionIds` (its collections, as the
 * picker shows them), and the collection's loaded entry lists. Idempotent, so the acting tab can apply
 * both its mutation response and the SSE event.
 */
export function applyCollectionEntriesChange(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  change: {
    subscriptionId: string;
    entryIds: string[];
    added: boolean;
    counts?: UnreadCounts;
  }
): void {
  const { subscriptionId, entryIds, added, counts } = change;
  if (counts) applyUnreadCounts(utils, queryClient, counts);
  const db = getLocalDb(queryClient);
  for (const entryId of entryIds) {
    setLeftCollectionLists(db.lists, entryId, subscriptionId, !added);
    setStoredEntryCollection(db.entries, entryId, subscriptionId, added);
    if (added) {
      // Its new membership places it in the collection's lists and those of
      // the collection's tags.
      const stored = db.entries.getSynced(entryId);
      if (stored) insertEntryIntoLists(db, stored);
    }
  }
}

/** An entry's read/starred state as the server reported it. */
export interface EntryStateChange {
  id: string;
  read: boolean;
  starred: boolean;
  updatedAt: Date;
  subscriptionIds?: string[];
  /** The entry's list item, when the server sent one with an unread flip. */
  listItem?: EntryRow;
}

/**
 * Applies read/starred changes from the server, whether a markRead/setStarred
 * response or an `entry_state_changed` event: the entries' state, their place
 * in unread-only lists, and the absolute counts. Idempotent, so the acting tab
 * can apply both its response and the event.
 */
export function applyEntryStateChanges(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  change: { entries: EntryStateChange[]; counts?: UnreadCounts }
): void {
  const db = getLocalDb(queryClient);
  for (const entry of change.entries) {
    setServerEntryState(db.entries, entry.id, entry);
    // An entry that became unread (here or on another device) belongs in
    // unread-only lists that don't contain it (fetched while it was read).
    // The list item lets it appear even when the store doesn't hold it (e.g.
    // marked unread on another device or via MCP), the same way new_entry
    // payloads make new entries appear live (#1237).
    if (entry.read) continue;
    if (entry.listItem) {
      addServerEntryToLists(db, entry.listItem);
    } else {
      const stored = db.entries.getSynced(entry.id);
      if (stored) insertEntryIntoLists(db, stored);
    }
  }
  if (change.counts) applyUnreadCounts(utils, queryClient, change.counts);
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
  counts?: UnreadCounts
): void {
  // Run whether or not the store holds it: an optimistic unsubscribe already
  // removed it, or it was never loaded (its tag collapsed), and the counts and
  // entries below still changed (#1081).
  removeSubscriptionFromCaches(subscriptionId, queryClient);

  applySubscriptionCounts(utils, counts, queryClient);

  // A deleted collection no longer holds anything, so its articles' pickers
  // don't count it.
  removeStoredEntryMemberships(getLocalDb(queryClient).entries, subscriptionId);
  // The collection picker searches on the server, so it refetches.
  void utils.subscriptions.list.invalidate({ type: "collection" });
  forgetDeletedSubscription(utils, subscriptionId);

  // Always invalidate entries.list - entries from this subscription should be filtered out
  utils.entries.list.invalidate();
}

/**
 * Applies a mark-all-read, from its mutation response or its event: the
 * absolute counts it carries, and a refetch of the entry lists, whose read
 * state it changed for possibly thousands of entries.
 */
export function handleMarkAllRead(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  counts: UnreadCounts
): void {
  applyUnreadCounts(utils, queryClient, counts);
  utils.entries.list.invalidate();
}

/**
 * Refetches the stored collections that have unread entries, after a catch-up
 * sync: an article that left a collection while this client was disconnected
 * isn't replayed, and a refetch of an unread-only section can't say a row it
 * left out went to zero.
 */
export function refreshStoredCollections(utils: TRPCClientUtils, queryClient: QueryClient): void {
  for (const row of getLocalDb(queryClient).subscriptions.rows.allSynced()) {
    if (row.type === "collection" && row.unreadCount > 0) {
      utils.subscriptions.get.fetch({ id: row.id }, { staleTime: 0 }).catch(() => {
        // Deleted meanwhile: its subscription_deleted event removes it.
      });
    }
  }
}

// ============================================================================
// Absolute Count Updates (Server-Provided Counts)
// ============================================================================

/** Absolute unread counts from a mutation response or event. */
export type UnreadCounts = z.infer<typeof unreadCountsSchema>;

/**
 * Applies absolute unread counts from the server. Each list keeps the newest
 * value (`countsAsOfSchema`), so applying the same counts twice, or older
 * ones after newer, leaves counts correct. A subscription the store lacks
 * that now has unread entries is loaded (`loadSubscriptionForSidebar`), so an
 * unread-only sidebar section that hid it can list it.
 */
export function applyUnreadCounts(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  counts: UnreadCounts
): void {
  const db = getLocalDb(queryClient);
  writeCounts(
    db.counts,
    [
      { list: { all: true }, unread: counts.all.unread },
      { list: { starred: true }, unread: counts.starred.unread },
      { list: { saved: true }, unread: counts.saved.unread },
      ...counts.tags.map((tag) => ({ list: { tagId: tag.id }, unread: tag.unread })),
      ...(counts.uncategorized
        ? [{ list: { uncategorized: true } as const, unread: counts.uncategorized.unread }]
        : []),
    ],
    counts.asOf
  );
  for (const { id, unread, tagIds } of counts.subscriptions) {
    const stored = writeSubscriptionCount(db.subscriptions, id, unread, counts.asOf);
    if (!stored && unread > 0) loadSubscriptionForSidebar(utils, queryClient, id, tagIds);
  }
}

/**
 * Fetches a subscription the store lacks into it, when a loaded sidebar
 * section may list it: one with these tags. One that only collapsed tags
 * would list isn't fetched; expanding them loads it.
 */
function loadSubscriptionForSidebar(
  utils: TRPCClientUtils,
  queryClient: QueryClient,
  id: string,
  tagIds: string[]
): void {
  if (!isSidebarSectionLoaded(queryClient, tagIds)) return;
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
