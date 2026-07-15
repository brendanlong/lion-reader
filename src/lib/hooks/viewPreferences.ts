/**
 * View Preferences Types and Constants
 *
 * Contains types and default values for view preferences.
 * Preferences are synced to URL query params (see useUrlViewPreferences).
 */

import { ENTRY_SEARCH_ENABLED } from "@/lib/feature-flags";

/**
 * View types for different entry list pages.
 */
export type ViewType =
  | "all"
  | "starred"
  | "subscription"
  | "tag"
  | "saved"
  | "uncategorized"
  | "recently-read";

/**
 * View preference settings.
 */
export interface ViewPreferences {
  /**
   * Show only unread items.
   */
  showUnreadOnly: boolean;

  /**
   * Sort order for entries: "newest" (default) or "oldest".
   */
  sortOrder: "newest" | "oldest";
}

/**
 * Default preferences for all views.
 */
const DEFAULT_PREFERENCES: ViewPreferences = {
  showUnreadOnly: true,
  sortOrder: "newest",
};

/**
 * Parse view preferences from URL search params.
 * Uses DEFAULT_PREFERENCES when not specified in URL (no localStorage fallback
 * to avoid hydration mismatches between server and client).
 *
 * This function is kept in a non-"use client" file so it can be used
 * for server-side prefetching as well as client-side rendering.
 */
export function parseViewPreferencesFromParams(
  searchParams: URLSearchParams | null,
  defaults?: { unreadOnly?: boolean }
): {
  unreadOnly: boolean;
  sortOrder: "newest" | "oldest";
  searchQuery: string | undefined;
} {
  // Parse the full-text search query - empty/whitespace means "not searching".
  // While search is disabled (#1249) the param is ignored entirely, so a
  // lingering ?q= deep link renders the plain list instead of erroring — this
  // is the single frontend choke point (both server prefetch and client parse
  // flow through here).
  const searchQuery = ENTRY_SEARCH_ENABLED
    ? searchParams?.get("q")?.trim() || undefined
    : undefined;

  // Parse unreadOnly - explicit "false" means show all, anything else uses default.
  // While searching, the default flips to showing everything: a search is
  // usually for something already read, and silently searching only unread
  // entries would hide the results the user is looking for.
  const unreadOnlyParam = searchParams?.get("unreadOnly");
  const defaultUnreadOnly = searchQuery
    ? false
    : (defaults?.unreadOnly ?? DEFAULT_PREFERENCES.showUnreadOnly);
  const unreadOnly =
    unreadOnlyParam === "false" ? false : unreadOnlyParam === "true" ? true : defaultUnreadOnly;

  // Parse sortOrder - explicit "oldest" means oldest first, anything else uses default
  const sortParam = searchParams?.get("sort");
  const sortOrder =
    sortParam === "oldest"
      ? "oldest"
      : sortParam === "newest"
        ? "newest"
        : DEFAULT_PREFERENCES.sortOrder;

  return { unreadOnly, sortOrder, searchQuery };
}
