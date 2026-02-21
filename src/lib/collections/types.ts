/**
 * Collection Types
 *
 * TypeScript types for TanStack DB collections, inferred from tRPC router outputs.
 * These types represent the normalized data stored in each collection.
 */

import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/trpc/root";

type RouterOutputs = inferRouterOutputs<AppRouter>;

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/**
 * A single subscription as returned by subscriptions.list or subscriptions.get.
 * This is the primary user-facing identifier for a feed.
 */
export type Subscription = RouterOutputs["subscriptions"]["list"]["items"][number];

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * An entry list item as returned by entries.list.
 * Does not include full content (contentOriginal/contentCleaned).
 */
export type EntryListItem = RouterOutputs["entries"]["list"]["items"][number];

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/**
 * A tag as returned by tags.list.
 */
export type TagItem = RouterOutputs["tags"]["list"]["items"][number];

/**
 * Uncategorized subscription counts from tags.list.
 */
export type UncategorizedCounts = RouterOutputs["tags"]["list"]["uncategorized"];

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

/**
 * Entry counts (total + unread) for a specific filter combination.
 * Stored in the local-only counts collection keyed by a string identifier.
 */
export interface CountRecord {
  /** Unique key for this count (e.g., "all", "starred", "saved") */
  id: string;
  /** Total entries matching this filter */
  total: number;
  /** Unread entries matching this filter */
  unread: number;
}
