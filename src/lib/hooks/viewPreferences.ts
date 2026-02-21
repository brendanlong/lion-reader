/**
 * View Preferences Types and Constants
 *
 * Contains types and default values for view preferences.
 * Preferences are synced to URL query params (see useUrlViewPreferences).
 */

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
  | "recently-read"
  | "best";

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
} {
  // Parse unreadOnly - explicit "false" means show all, anything else uses default
  const unreadOnlyParam = searchParams?.get("unreadOnly");
  const defaultUnreadOnly = defaults?.unreadOnly ?? DEFAULT_PREFERENCES.showUnreadOnly;
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

  return { unreadOnly, sortOrder };
}
