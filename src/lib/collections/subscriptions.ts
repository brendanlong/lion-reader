/**
 * Subscriptions Collection
 *
 * Local-only collection of user subscriptions.
 * Populated incrementally as sidebar tag sections load pages via useInfiniteQuery,
 * and by SSE/sync events (addSubscriptionToCollection, removeSubscriptionFromCollection).
 *
 * Used for:
 * - Fast synchronous lookups by ID (collection.get(id))
 * - Optimistic unread count updates (writeUpdate)
 * - findCachedSubscription fallback
 */

import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import type { Subscription } from "./types";

/**
 * Creates the subscriptions collection as a local-only store.
 *
 * Unlike query-backed collections, this doesn't fetch data automatically.
 * Data flows in from:
 * 1. TagSubscriptionList useInfiniteQuery pages (via writeInsert/writeUpdate)
 * 2. SSE subscription_created events (via addSubscriptionToCollection)
 * 3. SSE subscription_deleted events (via removeSubscriptionFromCollection)
 */
export function createSubscriptionsCollection() {
  return createCollection(
    localOnlyCollectionOptions({
      id: "subscriptions",
      getKey: (item: Subscription) => item.id,
    })
  );
}

export type SubscriptionsCollection = ReturnType<typeof createSubscriptionsCollection>;
