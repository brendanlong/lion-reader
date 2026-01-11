/**
 * View Preferences Shared Module
 *
 * Contains shared types, constants, and utilities for view preferences
 * that can be used by both server and client code.
 */

/**
 * View types for storing separate preferences.
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
 * Default preferences for new views.
 */
export const DEFAULT_PREFERENCES: ViewPreferences = {
  showUnreadOnly: true,
  sortOrder: "newest",
};

/**
 * Generate localStorage key for a view.
 */
export function getStorageKey(viewType: ViewType, viewId?: string): string {
  if (viewId) {
    return `lion-reader:view-prefs:${viewType}:${viewId}`;
  }
  return `lion-reader:view-prefs:${viewType}`;
}

/**
 * Load preferences from localStorage.
 */
export function loadPreferences(key: string): ViewPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_PREFERENCES;
  }

  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<ViewPreferences>;
      return {
        ...DEFAULT_PREFERENCES,
        ...parsed,
      };
    }
  } catch {
    // Invalid JSON, use defaults
  }

  return DEFAULT_PREFERENCES;
}

/**
 * Get view preferences synchronously.
 *
 * On the server, this returns DEFAULT_PREFERENCES.
 * On the client, this reads from localStorage (with caching).
 *
 * @param viewType - The type of view (all, starred, feed, tag, saved, uncategorized)
 * @param viewId - Optional ID for feed or tag views
 * @returns The current view preferences
 */
export function getViewPreferences(viewType: ViewType, viewId?: string): ViewPreferences {
  const key = getStorageKey(viewType, viewId);
  return loadPreferences(key);
}
