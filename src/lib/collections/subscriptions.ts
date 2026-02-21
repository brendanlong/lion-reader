/**
 * Subscriptions Collections
 *
 * Two collection types:
 *
 * 1. **Global subscriptions collection** (local-only): Singleton for SSE state updates,
 *    fast lookups by ID, and optimistic unread count updates.
 *
 * 2. **Tag subscriptions collection** (on-demand, query-backed): Per-tag/uncategorized
 *    collection that drives the sidebar subscription list UI. Created per tag section,
 *    fetches pages from the server on demand as the user scrolls.
 */

import { createCollection, localOnlyCollectionOptions } from "@tanstack/react-db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import type { QueryClient } from "@tanstack/react-query";
import type { Subscription } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Server response from subscriptions.list */
interface SubscriptionsListResponse {
  items: Subscription[];
  nextCursor?: string;
}

/** Filter params baked into a tag subscription collection */
export interface TagSubscriptionFilters {
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  limit: number;
}

// ---------------------------------------------------------------------------
// Global subscriptions collection (local-only)
// ---------------------------------------------------------------------------

/**
 * Creates the global subscriptions collection as a local-only store.
 *
 * Used for:
 * - Fast synchronous lookups by ID (collection.get(id))
 * - Optimistic unread count updates
 * - SSE subscription_created/deleted events
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

// ---------------------------------------------------------------------------
// Tag subscriptions collection (on-demand, query-backed)
// ---------------------------------------------------------------------------

/**
 * Generates a stable string key for a tag subscription filter combination.
 */
export function stableTagFilterKey(filters: TagSubscriptionFilters): string {
  return JSON.stringify([
    filters.tagId ?? null,
    filters.uncategorized ?? null,
    filters.unreadOnly ?? null,
    filters.limit,
  ]);
}

/**
 * Creates an on-demand subscriptions collection for a specific tag/uncategorized section.
 *
 * Same offset-to-cursor bridge pattern as entries view collections.
 *
 * @param queryClient - The shared QueryClient instance
 * @param fetchSubscriptions - Function to fetch a page from the server
 * @param filters - The filter parameters for this section
 */
export function createTagSubscriptionsCollection(
  queryClient: QueryClient,
  fetchSubscriptions: (params: {
    tagId?: string;
    uncategorized?: boolean;
    unreadOnly?: boolean;
    cursor?: string;
    limit: number;
  }) => Promise<SubscriptionsListResponse>,
  filters: TagSubscriptionFilters
) {
  const cursorByOffset = new Map<number, string>();

  return createCollection(
    queryCollectionOptions({
      id: `subscriptions-tag-${stableTagFilterKey(filters)}`,
      syncMode: "on-demand" as const,
      queryKey: ["subscriptions-tag", stableTagFilterKey(filters)],
      queryClient,
      getKey: (item: Subscription) => item.id,
      staleTime: Infinity,
      queryFn: async (ctx) => {
        const opts = ctx.meta?.loadSubsetOptions as { offset?: number; limit?: number } | undefined;
        const offset = opts?.offset ?? 0;
        const limit = opts?.limit ?? filters.limit;

        // Map offset to cursor for subsequent pages
        const cursor = offset > 0 ? cursorByOffset.get(offset) : undefined;
        if (offset > 0 && !cursor) {
          return { items: [] };
        }

        const result = await fetchSubscriptions({
          tagId: filters.tagId,
          uncategorized: filters.uncategorized,
          unreadOnly: filters.unreadOnly,
          cursor,
          limit,
        });

        if (result.nextCursor) {
          cursorByOffset.set(offset + result.items.length, result.nextCursor);
        }

        return result;
      },
      select: (data: SubscriptionsListResponse): Subscription[] => data.items,
    })
  );
}

export type TagSubscriptionsCollection = ReturnType<typeof createTagSubscriptionsCollection>;
