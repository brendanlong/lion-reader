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

import { extractParamsFromPathname } from "@/lib/navigation";
import type { EntryType } from "@/lib/entry-types";
import { sortFieldOf, type EntrySortOrder } from "@/lib/entry-sort";

/**
 * Input parameters for entries.list query.
 * All optional fields should be explicitly undefined (not omitted) for cache key matching.
 */
export interface EntriesListInput {
  query: string | undefined;
  subscriptionId: string | undefined;
  tagId: string | undefined;
  uncategorized: boolean | undefined;
  unreadOnly: boolean;
  starredOnly: boolean | undefined;
  sortOrder: EntrySortOrder | undefined;
  sortBy: "published" | "readChanged" | "score" | "position" | undefined;
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
  sortBy?: "published" | "readChanged";
}

/**
 * View preferences for the entries list.
 */
export interface EntriesListViewPreferences {
  unreadOnly: boolean;
  /** The chosen sort, by its direction (`sortFieldOf`); undefined leaves it to the list. */
  sortOrder?: EntrySortOrder;
  /** Full-text search query (`?q=` URL param); undefined when not searching. */
  searchQuery?: string;
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
  // Normalize the search query: empty/whitespace means "not searching".
  const query = preferences.searchQuery?.trim() || undefined;
  // The backend ignores sortOrder when a query is provided (results are ranked
  // by relevance), so canonicalize it while searching — a lingering ?sort=
  // param must not fragment the cache key for the same search. Recently Read
  // sorts only by date, and only a subscription's list by position (#2064):
  // a choice the view can't use, like none, leaves it to the list.
  const field = preferences.sortOrder && sortFieldOf(preferences.sortOrder);
  const usable =
    !query &&
    (field === "published" ||
      (filters.sortBy !== "readChanged" && (field === "score" || !!filters.subscriptionId)));
  const sortOrder = usable ? preferences.sortOrder : undefined;
  const sortBy = usable && field !== "published" ? field : filters.sortBy;
  // Construct the input with explicit property order and explicit undefined values.
  // This ensures the object structure is identical regardless of where it's constructed.
  // NOTE: direction is required for tRPC infinite query cache key matching.
  // Direction depends on sort order: "newest" fetches forward, "oldest" fetches backward.
  return {
    query,
    subscriptionId: filters.subscriptionId,
    tagId: filters.tagId,
    uncategorized: filters.uncategorized,
    unreadOnly: preferences.unreadOnly,
    starredOnly: filters.starredOnly,
    sortOrder,
    sortBy,
    type: filters.type,
    limit,
    direction:
      sortOrder === "oldest" || sortOrder === "lowest" || sortOrder === "last"
        ? "backward"
        : "forward",
  };
}

/**
 * Extract entry list filters from a pathname.
 *
 * This is the single source of truth for mapping routes to filters.
 * Used by: client hooks, sidebar prefetch, server-side prefetch.
 */
export function getFiltersFromPathname(pathname: string): EntriesListFilters {
  const { subscriptionId, tagId } = extractParamsFromPathname(pathname);

  // /subscription/:id
  if (subscriptionId) {
    return { subscriptionId };
  }

  // /tag/:tagId
  if (tagId) {
    // Handle "uncategorized" pseudo-tag
    if (tagId === "uncategorized") {
      return { uncategorized: true };
    }
    return { tagId };
  }

  // /starred
  if (pathname === "/starred") {
    return { starredOnly: true };
  }

  // /saved
  if (pathname === "/saved") {
    return { type: "saved" as const };
  }

  // /uncategorized
  if (pathname === "/uncategorized") {
    return { uncategorized: true };
  }

  // /recently-read
  if (pathname === "/recently-read") {
    return { sortBy: "readChanged" as const };
  }

  // /all or default
  return {};
}

/**
 * Returns the default view preferences for a given pathname.
 *
 * This is the single source of truth for per-route defaults.
 * Most views default to unreadOnly=true; /recently-read to unreadOnly=false.
 * The sort is left to the list.
 */
export function getDefaultViewPreferences(pathname: string): EntriesListViewPreferences {
  return { unreadOnly: pathname === "/recently-read" ? false : true };
}

/**
 * Build entries.list input from just a pathname (no search params).
 *
 * Convenience function for cases where search params aren't available,
 * such as sidebar mousedown prefetch. Uses default view preferences
 * for the route.
 */
export function buildEntriesListInputForRoute(pathname: string): EntriesListInput {
  const filters = getFiltersFromPathname(pathname);
  const preferences = getDefaultViewPreferences(pathname);
  return buildEntriesListInput(filters, preferences);
}
