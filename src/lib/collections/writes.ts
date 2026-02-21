/**
 * Collection Write Utilities
 *
 * Functions that update TanStack DB collections for client-side state management.
 * Each function accepts `Collections | null` and no-ops when null.
 *
 * Local-only collections (subscriptions, entries, counts) use direct mutation
 * methods: collection.insert(), collection.update(), collection.delete().
 *
 * Query-backed collections (tags) use collection.utils.writeInsert/writeUpdate/writeDelete
 * which write directly to the synced data store.
 */

import type { Collections } from "./index";
import type { Subscription, TagItem, EntryListItem } from "./types";

// ============================================================================
// Subscription Collection Writes (local-only)
// ============================================================================

/**
 * Adjusts subscription unread counts by delta values.
 * Used by handleEntriesMarkedRead, handleNewEntry, etc.
 */
export function adjustSubscriptionUnreadInCollection(
  collections: Collections | null,
  subscriptionDeltas: Map<string, number>
): void {
  if (!collections || subscriptionDeltas.size === 0) return;

  for (const [id, delta] of subscriptionDeltas) {
    const current = collections.subscriptions.get(id);
    if (current) {
      collections.subscriptions.update(id, (draft) => {
        draft.unreadCount = Math.max(0, current.unreadCount + delta);
      });
    }
  }
}

/**
 * Sets the absolute unread count for a single subscription.
 * Used by setCounts when server returns authoritative counts.
 */
export function setSubscriptionUnreadInCollection(
  collections: Collections | null,
  subscriptionId: string,
  unread: number
): void {
  if (!collections) return;

  const current = collections.subscriptions.get(subscriptionId);
  if (current) {
    collections.subscriptions.update(subscriptionId, (draft) => {
      draft.unreadCount = unread;
    });
  }
}

/**
 * Sets absolute unread counts for multiple subscriptions.
 * Used by setBulkCounts after markRead mutation.
 */
export function setBulkSubscriptionUnreadInCollection(
  collections: Collections | null,
  updates: Map<string, number>
): void {
  if (!collections || updates.size === 0) return;

  for (const [id, unread] of updates) {
    const current = collections.subscriptions.get(id);
    if (current) {
      collections.subscriptions.update(id, (draft) => {
        draft.unreadCount = unread;
      });
    }
  }
}

/**
 * Adds a new subscription to the collection.
 * Used by handleSubscriptionCreated (SSE/sync events).
 */
export function addSubscriptionToCollection(
  collections: Collections | null,
  subscription: Subscription
): void {
  if (!collections) return;

  // Check for duplicates (SSE race condition)
  if (collections.subscriptions.has(subscription.id)) return;

  collections.subscriptions.insert(subscription);
}

/**
 * Removes a subscription from the collection.
 * Used by handleSubscriptionDeleted.
 */
export function removeSubscriptionFromCollection(
  collections: Collections | null,
  subscriptionId: string
): void {
  if (!collections) return;

  if (collections.subscriptions.has(subscriptionId)) {
    collections.subscriptions.delete(subscriptionId);
  }
}

/**
 * Upserts subscriptions into the collection from infinite query pages.
 * Called by TagSubscriptionList as pages load, so the collection accumulates
 * subscriptions for fast lookups and optimistic updates.
 */
export function upsertSubscriptionsInCollection(
  collections: Collections | null,
  subscriptions: Subscription[]
): void {
  if (!collections || subscriptions.length === 0) return;

  for (const sub of subscriptions) {
    if (collections.subscriptions.has(sub.id)) {
      collections.subscriptions.update(sub.id, (draft) => {
        Object.assign(draft, sub);
      });
    } else {
      collections.subscriptions.insert(sub);
    }
  }
}

/**
 * Zeroes out unread counts for subscriptions matching markAllRead filters.
 *
 * - No filter: all subscriptions set to 0
 * - subscriptionId: only that subscription
 * - tagId: all subscriptions whose `tags` array contains that tag
 */
export function zeroSubscriptionUnreadForMarkAllRead(
  collections: Collections | null,
  filters: {
    subscriptionId?: string;
    tagId?: string;
  }
): void {
  if (!collections) return;

  if (filters.subscriptionId) {
    // Single subscription
    const current = collections.subscriptions.get(filters.subscriptionId);
    if (current) {
      collections.subscriptions.update(filters.subscriptionId, (draft) => {
        draft.unreadCount = 0;
      });
    }
  } else if (filters.tagId) {
    // All subscriptions with this tag
    collections.subscriptions.forEach((sub) => {
      if (sub.tags.some((t) => t.id === filters.tagId) && sub.unreadCount > 0) {
        collections.subscriptions.update(sub.id, (draft) => {
          draft.unreadCount = 0;
        });
      }
    });
  } else {
    // No filter: zero out all subscriptions
    collections.subscriptions.forEach((sub) => {
      if (sub.unreadCount > 0) {
        collections.subscriptions.update(sub.id, (draft) => {
          draft.unreadCount = 0;
        });
      }
    });
  }
}

// ============================================================================
// Tag Collection Writes (query-backed)
// ============================================================================

/**
 * Adjusts tag unread counts by delta values.
 * Used by handleEntriesMarkedRead, handleNewEntry, etc.
 *
 * Note: uncategorized counts are stored in the counts collection
 * (populated by the tags.list fetch) and updated via adjustUncategorizedUnreadInCollection.
 */
export function adjustTagUnreadInCollection(
  collections: Collections | null,
  tagDeltas: Map<string, number>
): void {
  if (!collections || tagDeltas.size === 0) return;

  const updates: Array<Partial<TagItem> & { id: string }> = [];
  for (const [id, delta] of tagDeltas) {
    const current = collections.tags.get(id);
    if (current) {
      updates.push({ id, unreadCount: Math.max(0, current.unreadCount + delta) });
    }
  }
  if (updates.length > 0) {
    collections.tags.utils.writeUpdate(updates);
  }
}

/**
 * Sets the absolute unread count for a single tag.
 * Used by setCounts/setBulkCounts when server returns authoritative counts.
 */
export function setTagUnreadInCollection(
  collections: Collections | null,
  tagId: string,
  unread: number
): void {
  if (!collections) return;

  const current = collections.tags.get(tagId);
  if (current) {
    collections.tags.utils.writeUpdate({ id: tagId, unreadCount: unread });
  }
}

/**
 * Adjusts the feedCount for a tag (used when subscriptions are created/deleted).
 */
export function adjustTagFeedCountInCollection(
  collections: Collections | null,
  tagId: string,
  delta: number
): void {
  if (!collections) return;

  const current = collections.tags.get(tagId);
  if (current) {
    collections.tags.utils.writeUpdate({
      id: tagId,
      feedCount: Math.max(0, current.feedCount + delta),
    });
  }
}

/**
 * Adds a new tag to the collection.
 * Used by SSE tag_created events.
 */
export function addTagToCollection(
  collections: Collections | null,
  tag: { id: string; name: string; color: string | null }
): void {
  if (!collections) return;

  if (collections.tags.has(tag.id)) return;

  collections.tags.utils.writeInsert({
    id: tag.id,
    name: tag.name,
    color: tag.color,
    feedCount: 0,
    unreadCount: 0,
    createdAt: new Date(),
  } as TagItem);
}

/**
 * Updates a tag in the collection.
 * Used by SSE tag_updated events.
 */
export function updateTagInCollection(
  collections: Collections | null,
  tag: { id: string; name: string; color: string | null }
): void {
  if (!collections) return;

  if (collections.tags.has(tag.id)) {
    collections.tags.utils.writeUpdate({
      id: tag.id,
      name: tag.name,
      color: tag.color,
    });
  }
}

/**
 * Removes a tag from the collection.
 * Used by SSE tag_deleted events.
 */
export function removeTagFromCollection(collections: Collections | null, tagId: string): void {
  if (!collections) return;

  if (collections.tags.has(tagId)) {
    collections.tags.utils.writeDelete(tagId);
  }
}

// ============================================================================
// Entry Count Writes (via Counts Collection, local-only)
// ============================================================================

/**
 * Sets absolute entry counts from server response.
 * Used by setCounts/setBulkCounts when server returns authoritative counts.
 */
export function setEntriesCountInCollection(
  collections: Collections | null,
  key: "all" | "starred" | "saved",
  total: number,
  unread: number
): void {
  if (!collections) return;

  if (collections.counts.has(key)) {
    collections.counts.update(key, (draft) => {
      draft.total = total;
      draft.unread = unread;
    });
  } else {
    collections.counts.insert({ id: key, total, unread });
  }
}

/**
 * Adjusts entry counts by delta values.
 * Used by handleNewEntry, handleSubscriptionCreated/Deleted.
 */
export function adjustEntriesCountInCollection(
  collections: Collections | null,
  key: "all" | "starred" | "saved",
  totalDelta: number,
  unreadDelta: number
): void {
  if (!collections || (totalDelta === 0 && unreadDelta === 0)) return;

  const current = collections.counts.get(key);
  if (current) {
    collections.counts.update(key, (draft) => {
      draft.total = Math.max(0, current.total + totalDelta);
      draft.unread = Math.max(0, current.unread + unreadDelta);
    });
  }
}

/**
 * Sets the uncategorized unread count to an absolute value.
 * Used by setCounts/setBulkCounts when server returns authoritative counts.
 */
export function setUncategorizedUnreadInCollection(
  collections: Collections | null,
  unread: number
): void {
  if (!collections) return;

  const current = collections.counts.get("uncategorized");
  if (current) {
    collections.counts.update("uncategorized", (draft) => {
      draft.unread = unread;
    });
  }
}

// ============================================================================
// Uncategorized Count Delta Writes (via Counts Collection)
// ============================================================================

/**
 * Adjusts the uncategorized unread count by a delta value.
 * Stored in the counts collection under the "uncategorized" key.
 */
export function adjustUncategorizedUnreadInCollection(
  collections: Collections | null,
  delta: number
): void {
  if (!collections || delta === 0) return;

  const current = collections.counts.get("uncategorized");
  if (current) {
    collections.counts.update("uncategorized", (draft) => {
      draft.unread = Math.max(0, current.unread + delta);
    });
  }
}

/**
 * Adjusts the uncategorized feed count by a delta value.
 * Used when subscriptions with no tags are created or deleted.
 */
export function adjustUncategorizedFeedCountInCollection(
  collections: Collections | null,
  delta: number
): void {
  if (!collections || delta === 0) return;

  const current = collections.counts.get("uncategorized");
  if (current) {
    collections.counts.update("uncategorized", (draft) => {
      draft.total = Math.max(0, current.total + delta);
    });
  }
}

// ============================================================================
// Entry Collection Writes (global local-only + active view collection)
// ============================================================================

/**
 * Updates the read status for entries in both the global entries collection
 * and the active view collection (if any).
 *
 * Global collection: local-only, uses collection.update()
 * View collection: query-backed, uses collection.utils.writeUpdate()
 */
export function updateEntryReadInCollection(
  collections: Collections | null,
  entryIds: string[],
  read: boolean
): void {
  if (!collections || entryIds.length === 0) return;

  for (const id of entryIds) {
    if (collections.entries.has(id)) {
      collections.entries.update(id, (draft) => {
        draft.read = read;
      });
    }
  }

  // Also update the active view collection so useLiveInfiniteQuery picks up changes
  const viewCol = collections.activeViewCollection;
  if (viewCol) {
    const updates = entryIds.filter((id) => viewCol.has(id)).map((id) => ({ id, read }));
    if (updates.length > 0) {
      viewCol.utils.writeUpdate(updates);
    }
  }
}

/**
 * Updates the starred status for an entry in both the global entries collection
 * and the active view collection (if any).
 */
export function updateEntryStarredInCollection(
  collections: Collections | null,
  entryId: string,
  starred: boolean
): void {
  if (!collections) return;

  if (collections.entries.has(entryId)) {
    collections.entries.update(entryId, (draft) => {
      draft.starred = starred;
    });
  }

  // Also update the active view collection
  const viewCol = collections.activeViewCollection;
  if (viewCol?.has(entryId)) {
    viewCol.utils.writeUpdate({ id: entryId, starred });
  }
}

/**
 * Updates the score fields for an entry in both the global entries collection
 * and the active view collection (if any).
 */
export function updateEntryScoreInCollection(
  collections: Collections | null,
  entryId: string,
  score: number | null,
  implicitScore: number
): void {
  if (!collections) return;

  if (collections.entries.has(entryId)) {
    collections.entries.update(entryId, (draft) => {
      draft.score = score;
      draft.implicitScore = implicitScore;
    });
  }

  // Also update the active view collection
  const viewCol = collections.activeViewCollection;
  if (viewCol?.has(entryId)) {
    viewCol.utils.writeUpdate({ id: entryId, score, implicitScore });
  }
}

/**
 * Updates entry metadata (title, author, summary, url, publishedAt) in both
 * the global entries collection and the active view collection (if any).
 * Used for SSE entry_updated events.
 */
export function updateEntryMetadataInCollection(
  collections: Collections | null,
  entryId: string,
  metadata: Partial<EntryListItem>
): void {
  if (!collections) return;

  if (collections.entries.has(entryId)) {
    collections.entries.update(entryId, (draft) => {
      Object.assign(draft, metadata);
    });
  }

  // Also update the active view collection
  const viewCol = collections.activeViewCollection;
  if (viewCol?.has(entryId)) {
    viewCol.utils.writeUpdate({ id: entryId, ...metadata });
  }
}

/**
 * Upserts entries from tRPC infinite query pages into the collection.
 * Called as pages load to populate the local-only entries collection.
 *
 * Uses insert for new entries and update for existing ones (e.g., when
 * a refetch returns entries that were already loaded from a previous page).
 */
export function upsertEntriesInCollection(
  collections: Collections | null,
  entries: EntryListItem[]
): void {
  if (!collections || entries.length === 0) return;

  for (const entry of entries) {
    if (collections.entries.has(entry.id)) {
      collections.entries.update(entry.id, (draft) => {
        Object.assign(draft, entry);
      });
    } else {
      collections.entries.insert(entry);
    }
  }
}
