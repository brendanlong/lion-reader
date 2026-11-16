/**
 * Parses the view preferences synced to URL query params (see
 * useUrlViewPreferences). Kept out of a "use client" file so server-side
 * prefetching uses it too.
 */

import { ENTRY_SORT_ORDERS, type EntrySortOrder } from "@/lib/entry-sort";

/**
 * Parse view preferences from URL search params, falling back to the route's
 * `defaults` (never localStorage, which would make server and client disagree).
 */
export function parseViewPreferencesFromParams(
  searchParams: URLSearchParams,
  defaults: { unreadOnly: boolean }
): {
  unreadOnly: boolean;
  sortOrder: EntrySortOrder | undefined;
  searchQuery: string | undefined;
} {
  // Parse the full-text search query - empty/whitespace means "not searching".
  // This is the single frontend choke point (both server prefetch and client
  // parse flow through here).
  const searchQuery = searchParams.get("q")?.trim() || undefined;

  // Parse unreadOnly - explicit "false" means show all, anything else uses default.
  // While searching, the default flips to showing everything: a search is
  // usually for something already read, and silently searching only unread
  // entries would hide the results the user is looking for.
  const unreadOnlyParam = searchParams.get("unreadOnly");
  const defaultUnreadOnly = searchQuery ? false : defaults.unreadOnly;
  const unreadOnly =
    unreadOnlyParam === "false" ? false : unreadOnlyParam === "true" ? true : defaultUnreadOnly;

  // Parse sortOrder - any known direction, anything else leaves it to the list
  const sortParam = searchParams.get("sort");
  const sortOrder = ENTRY_SORT_ORDERS.find((order) => order === sortParam);

  return { unreadOnly, sortOrder, searchQuery };
}
