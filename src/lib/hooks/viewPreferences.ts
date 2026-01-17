/**
 * View Preferences Types and Constants
 *
 * Contains types and default values for view preferences.
 * Preferences are synced to URL query params (see useUrlViewPreferences).
 */

/**
 * View types for different entry list pages.
 */
export type ViewType = "all" | "starred" | "subscription" | "tag" | "saved" | "uncategorized";

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
export const DEFAULT_PREFERENCES: ViewPreferences = {
  showUnreadOnly: true,
  sortOrder: "newest",
};
