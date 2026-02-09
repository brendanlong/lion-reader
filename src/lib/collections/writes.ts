/**
 * Collection Write Utilities
 *
 * Functions that update TanStack DB collections alongside the existing React Query cache.
 * Each function accepts `Collections | null` and no-ops when null, enabling gradual
 * migration where callers can optionally pass collections.
 *
 * Uses `collection.utils.writeUpdate()` for query-backed collections, which writes
 * directly to the synced data store without triggering onInsert/onUpdate handlers
 * or query refetches.
 */

import type { Collections } from "./index";
import type { Subscription, TagItem, EntryListItem } from "./types";

// ============================================================================
// Subscription Collection Writes
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

  const updates: Array<Partial<Subscription> & { id: string }> = [];
  for (const [id, delta] of subscriptionDeltas) {
    const current = collections.subscriptions.get(id);
    if (current) {
      updates.push({ id, unreadCount: Math.max(0, current.unreadCount + delta) });
    }
  }
  if (updates.length > 0) {
    collections.subscriptions.utils.writeUpdate(updates);
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
    collections.subscriptions.utils.writeUpdate({ id: subscriptionId, unreadCount: unread });
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

  const writeUpdates: Array<Partial<Subscription> & { id: string }> = [];
  for (const [id, unread] of updates) {
    const current = collections.subscriptions.get(id);
    if (current) {
      writeUpdates.push({ id, unreadCount: unread });
    }
  }
  if (writeUpdates.length > 0) {
    collections.subscriptions.utils.writeUpdate(writeUpdates);
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

  collections.subscriptions.utils.writeInsert(subscription);
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
    collections.subscriptions.utils.writeDelete(subscriptionId);
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

  const inserts: Subscription[] = [];
  const updates: Array<Partial<Subscription> & { id: string }> = [];

  for (const sub of subscriptions) {
    if (collections.subscriptions.has(sub.id)) {
      updates.push(sub);
    } else {
      inserts.push(sub);
    }
  }

  if (inserts.length > 0) {
    collections.subscriptions.utils.writeInsert(inserts);
  }
  if (updates.length > 0) {
    collections.subscriptions.utils.writeUpdate(updates);
  }
}

// ============================================================================
// Tag Collection Writes
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
// Uncategorized Count Writes (via Counts Collection)
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
    collections.counts.utils.writeUpdate({
      id: "uncategorized",
      unread: Math.max(0, current.unread + delta),
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
    collections.counts.utils.writeUpdate({
      id: "uncategorized",
      total: Math.max(0, current.total + delta),
    });
  }
}

// ============================================================================
// Entry Collection Writes
// ============================================================================

/**
 * Updates the read status for entries in the collection.
 * No-ops for entries not currently in the collection.
 * This is O(1) per entry (by key lookup) — replaces the O(n) page scanning
 * in the old entry-cache.ts.
 */
export function updateEntryReadInCollection(
  collections: Collections | null,
  entryIds: string[],
  read: boolean
): void {
  if (!collections || entryIds.length === 0) return;

  const updates: Array<Partial<EntryListItem> & { id: string }> = [];
  for (const id of entryIds) {
    if (collections.entries.has(id)) {
      updates.push({ id, read });
    }
  }
  if (updates.length > 0) {
    collections.entries.utils.writeUpdate(updates);
  }
}

/**
 * Updates the starred status for an entry in the collection.
 */
export function updateEntryStarredInCollection(
  collections: Collections | null,
  entryId: string,
  starred: boolean
): void {
  if (!collections) return;

  if (collections.entries.has(entryId)) {
    collections.entries.utils.writeUpdate({ id: entryId, starred });
  }
}

/**
 * Updates the score fields for an entry in the collection.
 */
export function updateEntryScoreInCollection(
  collections: Collections | null,
  entryId: string,
  score: number | null,
  implicitScore: number
): void {
  if (!collections) return;

  if (collections.entries.has(entryId)) {
    collections.entries.utils.writeUpdate({ id: entryId, score, implicitScore });
  }
}

/**
 * Updates entry metadata (title, author, summary, url, publishedAt) in the collection.
 * Used for SSE entry_updated events.
 */
export function updateEntryMetadataInCollection(
  collections: Collections | null,
  entryId: string,
  metadata: Partial<EntryListItem>
): void {
  if (!collections) return;

  if (collections.entries.has(entryId)) {
    collections.entries.utils.writeUpdate({ id: entryId, ...metadata });
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

  const inserts: EntryListItem[] = [];
  const updates: Array<Partial<EntryListItem> & { id: string }> = [];

  for (const entry of entries) {
    if (collections.entries.has(entry.id)) {
      updates.push(entry);
    } else {
      inserts.push(entry);
    }
  }

  if (inserts.length > 0) {
    collections.entries.utils.writeInsert(inserts);
  }
  if (updates.length > 0) {
    collections.entries.utils.writeUpdate(updates);
  }
}
