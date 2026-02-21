/**
 * Cache Operations
 *
 * Higher-level functions for subscription lifecycle and count updates.
 * All state updates flow through TanStack DB collections.
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";
import type { Collections } from "@/lib/collections";
import { calculateTagDeltasFromSubscriptions } from "./count-cache";
import {
  adjustSubscriptionUnreadInCollection,
  adjustTagUnreadInCollection,
  adjustUncategorizedUnreadInCollection,
  addSubscriptionToCollection,
  removeSubscriptionFromCollection,
  setSubscriptionUnreadInCollection,
  setTagUnreadInCollection,
  setBulkSubscriptionUnreadInCollection,
  adjustTagFeedCountInCollection,
  adjustUncategorizedFeedCountInCollection,
  setEntriesCountInCollection,
  adjustEntriesCountInCollection,
  setUncategorizedUnreadInCollection,
} from "@/lib/collections/writes";

/**
 * Subscription data for adding to cache.
 */
export interface SubscriptionData {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  originalTitle: string | null;
  description: string | null;
  siteUrl: string | null;
  subscribedAt: Date;
  unreadCount: number;
  totalCount: number;
  tags: Array<{ id: string; name: string; color: string | null }>;
  fetchFullContent: boolean;
}

/**
 * Handles a new subscription being created.
 *
 * Updates TanStack DB collections:
 * - subscriptions collection (add subscription)
 * - tags/uncategorized counts (feedCount + unreadCount)
 * - entries counts ("all")
 */
export function handleSubscriptionCreated(
  utils: TRPCClientUtils,
  subscription: SubscriptionData,
  collections?: Collections | null
): void {
  // Add to TanStack DB subscriptions collection
  addSubscriptionToCollection(collections ?? null, subscription);

  // Update tag/uncategorized feedCount and unreadCount in collections
  if (subscription.tags.length === 0) {
    adjustUncategorizedFeedCountInCollection(collections ?? null, 1);
    adjustUncategorizedUnreadInCollection(collections ?? null, subscription.unreadCount);
  } else {
    for (const tag of subscription.tags) {
      adjustTagFeedCountInCollection(collections ?? null, tag.id, 1);
      const tagDeltas = new Map([[tag.id, subscription.unreadCount]]);
      adjustTagUnreadInCollection(collections ?? null, tagDeltas);
    }
  }

  // Update entry counts
  adjustEntriesCountInCollection(
    collections ?? null,
    "all",
    subscription.totalCount,
    subscription.unreadCount
  );
}

/**
 * Handles a subscription being deleted.
 *
 * Updates TanStack DB collections:
 * - subscriptions collection (remove subscription)
 * - tags/uncategorized counts (feedCount + unreadCount)
 * - entries counts ("all")
 */
export function handleSubscriptionDeleted(
  utils: TRPCClientUtils,
  subscriptionId: string,
  collections?: Collections | null
): void {
  // Look up subscription data before removing from collection
  const subscription = collections?.subscriptions.get(subscriptionId);

  if (subscription) {
    // Targeted updates using subscription data
    if (subscription.tags.length === 0) {
      adjustUncategorizedFeedCountInCollection(collections ?? null, -1);
      adjustUncategorizedUnreadInCollection(collections ?? null, -subscription.unreadCount);
    } else {
      for (const tag of subscription.tags) {
        adjustTagFeedCountInCollection(collections ?? null, tag.id, -1);
        const tagDeltas = new Map([[tag.id, -subscription.unreadCount]]);
        adjustTagUnreadInCollection(collections ?? null, tagDeltas);
      }
    }

    // Update entry counts
    adjustEntriesCountInCollection(
      collections ?? null,
      "all",
      -subscription.totalCount,
      -subscription.unreadCount
    );
  }

  // Remove from collection
  removeSubscriptionFromCollection(collections ?? null, subscriptionId);

  // Invalidate active entry view - entries from this subscription should be filtered out
  collections?.invalidateActiveView();
}

/**
 * Handles a new entry being created in a subscription.
 *
 * Updates TanStack DB collections:
 * - subscription unread count (+1)
 * - tag/uncategorized unread counts (+1)
 * - entries counts ("all" +1, "saved" +1 if saved)
 */
export function handleNewEntry(
  utils: TRPCClientUtils,
  subscriptionId: string | null,
  feedType: "web" | "email" | "saved",
  collections?: Collections | null
): void {
  // Update per-subscription and tag/uncategorized unread counts.
  // Same tradeoff as entry_state_changed: if the subscription isn't loaded
  // in the collection, tag deltas will be zero and counts may drift until
  // the tag section is expanded and refetched (see #623).
  if (subscriptionId) {
    const subscriptionDeltas = new Map<string, number>();
    subscriptionDeltas.set(subscriptionId, 1);

    adjustSubscriptionUnreadInCollection(collections ?? null, subscriptionDeltas);

    const { tagDeltas, uncategorizedDelta } = calculateTagDeltasFromSubscriptions(
      subscriptionDeltas,
      collections ?? null
    );
    adjustTagUnreadInCollection(collections ?? null, tagDeltas);
    adjustUncategorizedUnreadInCollection(collections ?? null, uncategorizedDelta);
  }

  // Update entry counts
  adjustEntriesCountInCollection(collections ?? null, "all", 1, 1);
  if (feedType === "saved") {
    adjustEntriesCountInCollection(collections ?? null, "saved", 1, 1);
  }
}

// ============================================================================
// Absolute Count Updates (Server-Provided Counts)
// ============================================================================

/**
 * Unread counts for a single entry, as returned by star/unstar mutations.
 */
export interface UnreadCounts {
  all: { total: number; unread: number };
  starred: { total: number; unread: number };
  saved?: { total: number; unread: number };
  subscription?: { id: string; unread: number };
  tags?: Array<{ id: string; unread: number }>;
  uncategorized?: { unread: number };
}

/**
 * Bulk unread counts, as returned by markRead mutation.
 */
export interface BulkUnreadCounts {
  all: { total: number; unread: number };
  starred: { total: number; unread: number };
  saved: { total: number; unread: number };
  subscriptions: Array<{ id: string; unread: number }>;
  tags: Array<{ id: string; unread: number }>;
  uncategorized?: { unread: number };
}

/**
 * Sets absolute counts from server response.
 * Used by single-entry mutations (star, unstar) that return UnreadCounts.
 */
export function setCounts(collections: Collections | null, counts: UnreadCounts): void {
  // Set global counts in collection
  setEntriesCountInCollection(collections, "all", counts.all.total, counts.all.unread);
  setEntriesCountInCollection(collections, "starred", counts.starred.total, counts.starred.unread);
  if (counts.saved) {
    setEntriesCountInCollection(collections, "saved", counts.saved.total, counts.saved.unread);
  }

  // Set subscription unread count
  if (counts.subscription) {
    setSubscriptionUnreadInCollection(
      collections,
      counts.subscription.id,
      counts.subscription.unread
    );
  }

  // Set tag unread counts
  if (counts.tags) {
    for (const tag of counts.tags) {
      setTagUnreadInCollection(collections, tag.id, tag.unread);
    }
  }

  // Set uncategorized count
  if (counts.uncategorized) {
    setUncategorizedUnreadInCollection(collections, counts.uncategorized.unread);
  }
}

/**
 * Sets absolute counts from bulk mutation response.
 * Used by markRead mutation that returns BulkUnreadCounts.
 */
export function setBulkCounts(collections: Collections | null, counts: BulkUnreadCounts): void {
  // Set global counts in collection
  setEntriesCountInCollection(collections, "all", counts.all.total, counts.all.unread);
  setEntriesCountInCollection(collections, "starred", counts.starred.total, counts.starred.unread);
  setEntriesCountInCollection(collections, "saved", counts.saved.total, counts.saved.unread);

  // Set subscription unread counts
  const subscriptionUpdates = new Map(counts.subscriptions.map((s) => [s.id, s.unread]));
  setBulkSubscriptionUnreadInCollection(collections, subscriptionUpdates);

  // Set tag unread counts
  for (const tag of counts.tags) {
    setTagUnreadInCollection(collections, tag.id, tag.unread);
  }

  // Set uncategorized count
  if (counts.uncategorized) {
    setUncategorizedUnreadInCollection(collections, counts.uncategorized.unread);
  }
}

/**
 * Fetches fresh global counts from the server and writes to the counts collection.
 * Used after operations that don't return counts (markAllRead, OPML import, error recovery).
 */
export async function refreshGlobalCounts(
  utils: TRPCClientUtils,
  collections: Collections | null
): Promise<void> {
  if (!collections) return;
  const [all, starred, saved] = await Promise.all([
    utils.entries.count.fetch({}),
    utils.entries.count.fetch({ starredOnly: true }),
    utils.entries.count.fetch({ type: "saved" }),
  ]);
  setEntriesCountInCollection(collections, "all", all.total, all.unread);
  setEntriesCountInCollection(collections, "starred", starred.total, starred.unread);
  setEntriesCountInCollection(collections, "saved", saved.total, saved.unread);
}
