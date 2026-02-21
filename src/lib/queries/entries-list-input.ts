/**
 * Shared input builder for entries.list query
 *
 * This ensures the query input is constructed identically on both server (prefetch)
 * and client (query hook), which is critical for React Query cache matching.
 *
 * Without this, subtle differences in object construction (property order,
 * undefined handling during serialization) can cause the prefetched data to
 * not be found by the client query, leading to hydration mismatches.
 */

/**
 * Entry type filter options.
 */
export type EntryType = "web" | "email" | "saved";

/**
 * Input parameters for entries.list query.
 * All optional fields should be explicitly undefined (not omitted) for cache key matching.
 */
export interface EntriesListInput {
  subscriptionId: string | undefined;
  tagId: string | undefined;
  uncategorized: boolean | undefined;
  unreadOnly: boolean;
  starredOnly: boolean | undefined;
  sortOrder: "newest" | "oldest";
  sortBy: "published" | "readChanged" | "predictedScore" | undefined;
  type: EntryType | undefined;
  limit: number;
  /**
   * Direction for infinite query pagination.
   * tRPC adds this automatically for useInfiniteQuery, so we must include it
   * in server-side prefetchInfinite for cache key matching.
   */
  direction: "forward" | "backward";
}

/**
 * Filter options passed to buildEntriesListInput.
 */
export interface EntriesListFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  starredOnly?: boolean;
  type?: EntryType;
  sortBy?: "published" | "readChanged" | "predictedScore";
}

/**
 * View preferences for the entries list.
 */
export interface EntriesListViewPreferences {
  unreadOnly: boolean;
  sortOrder: "newest" | "oldest";
}

/**
 * Builds a standardized input object for the entries.list query.
 *
 * This function must be used by both:
 * - Server-side prefetching (EntryListPage)
 * - Client-side query hooks (useEntryListQuery)
 *
 * The input object structure must be identical for React Query to match
 * the prefetched data with the client query.
 *
 * @param filters - Base filters (subscriptionId, tagId, etc.)
 * @param preferences - View preferences (unreadOnly, sortOrder)
 * @param limit - Number of entries per page (default: 10)
 */
export function buildEntriesListInput(
  filters: EntriesListFilters,
  preferences: EntriesListViewPreferences,
  limit: number = 10
): EntriesListInput {
  // Construct the input with explicit property order and explicit undefined values.
  // This ensures the object structure is identical regardless of where it's constructed.
  // NOTE: direction is required for tRPC infinite query cache key matching.
  // Direction depends on sort order: "newest" fetches forward, "oldest" fetches backward.
  return {
    subscriptionId: filters.subscriptionId,
    tagId: filters.tagId,
    uncategorized: filters.uncategorized,
    unreadOnly: preferences.unreadOnly,
    starredOnly: filters.starredOnly,
    sortOrder: preferences.sortOrder,
    sortBy: filters.sortBy,
    type: filters.type,
    limit,
    direction: preferences.sortOrder === "newest" ? "forward" : "backward",
  };
}
