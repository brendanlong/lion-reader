/**
 * useViewPreferences Hook
 *
 * Manages user preferences for entry/article list views.
 * Persists preferences in localStorage per view (all, starred, feed, tag, saved).
 *
 * Preferences include:
 * - showUnreadOnly: Whether to show only unread items (default: true)
 */

"use client";

import { useSyncExternalStore, useCallback, useMemo } from "react";

/**
 * View types for storing separate preferences.
 */
export type ViewType = "all" | "starred" | "feed" | "tag" | "saved";

/**
 * View preference settings.
 */
export interface ViewPreferences {
  /**
   * Show only unread items.
   */
  showUnreadOnly: boolean;
}

/**
 * Result of the useViewPreferences hook.
 */
export interface UseViewPreferencesResult {
  /**
   * Current preference: show only unread items.
   */
  showUnreadOnly: boolean;

  /**
   * Toggle the showUnreadOnly preference.
   */
  toggleShowUnreadOnly: () => void;

  /**
   * Set the showUnreadOnly preference directly.
   */
  setShowUnreadOnly: (value: boolean) => void;
}

/**
 * Default preferences for new views.
 */
const DEFAULT_PREFERENCES: ViewPreferences = {
  showUnreadOnly: true,
};

/**
 * Generate localStorage key for a view.
 */
function getStorageKey(viewType: ViewType, viewId?: string): string {
  if (viewId) {
    return `lion-reader:view-prefs:${viewType}:${viewId}`;
  }
  return `lion-reader:view-prefs:${viewType}`;
}

/**
 * Load preferences from localStorage.
 */
function loadPreferences(key: string): ViewPreferences {
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
 * Save preferences to localStorage.
 */
function savePreferences(key: string, prefs: ViewPreferences): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // Storage full or unavailable, ignore
  }
}

// Map of storage key to listeners for that key
const listeners = new Map<string, Set<() => void>>();

// Cache for snapshot values to avoid infinite loops with useSyncExternalStore
const snapshotCache = new Map<string, ViewPreferences>();

/**
 * Get cached snapshot, loading from localStorage if not cached.
 */
function getSnapshotCached(key: string): ViewPreferences {
  if (!snapshotCache.has(key)) {
    snapshotCache.set(key, loadPreferences(key));
  }
  return snapshotCache.get(key)!;
}

/**
 * Update the cache and notify listeners.
 */
function updateCache(key: string, prefs: ViewPreferences): void {
  snapshotCache.set(key, prefs);
  savePreferences(key, prefs);
  notifyListeners(key);
}

/**
 * Subscribe to localStorage changes for a specific key.
 */
function subscribe(key: string, callback: () => void): () => void {
  if (!listeners.has(key)) {
    listeners.set(key, new Set());
  }
  listeners.get(key)!.add(callback);

  return () => {
    listeners.get(key)?.delete(callback);
    if (listeners.get(key)?.size === 0) {
      listeners.delete(key);
    }
  };
}

/**
 * Notify all listeners for a storage key.
 */
function notifyListeners(key: string): void {
  listeners.get(key)?.forEach((callback) => callback());
}

/**
 * Hook for managing view preferences with localStorage persistence.
 *
 * Uses useSyncExternalStore for proper React 18 concurrent mode support.
 *
 * @param viewType - The type of view (all, starred, feed, tag, saved)
 * @param viewId - Optional ID for feed or tag views
 * @returns View preferences and setters
 *
 * @example
 * ```tsx
 * function AllEntriesPage() {
 *   const { showUnreadOnly, toggleShowUnreadOnly } = useViewPreferences('all');
 *
 *   return (
 *     <>
 *       <button onClick={toggleShowUnreadOnly}>
 *         {showUnreadOnly ? 'Show all' : 'Show unread only'}
 *       </button>
 *       <EntryList filters={{ unreadOnly: showUnreadOnly }} />
 *     </>
 *   );
 * }
 * ```
 */
export function useViewPreferences(viewType: ViewType, viewId?: string): UseViewPreferencesResult {
  const storageKey = getStorageKey(viewType, viewId);

  // Create stable subscribe function for this key
  const subscribeToKey = useCallback(
    (callback: () => void) => subscribe(storageKey, callback),
    [storageKey]
  );

  // Create stable getSnapshot function that returns cached value
  const getSnapshot = useCallback(() => getSnapshotCached(storageKey), [storageKey]);

  // Server snapshot always returns defaults
  const getServerSnapshot = useCallback(() => DEFAULT_PREFERENCES, []);

  // Use useSyncExternalStore for React 18 concurrent mode support
  const preferences = useSyncExternalStore(subscribeToKey, getSnapshot, getServerSnapshot);

  const toggleShowUnreadOnly = useCallback(() => {
    const current = getSnapshotCached(storageKey);
    const updated = { ...current, showUnreadOnly: !current.showUnreadOnly };
    updateCache(storageKey, updated);
  }, [storageKey]);

  const setShowUnreadOnly = useCallback(
    (value: boolean) => {
      const current = getSnapshotCached(storageKey);
      const updated = { ...current, showUnreadOnly: value };
      updateCache(storageKey, updated);
    },
    [storageKey]
  );

  return useMemo(
    () => ({
      showUnreadOnly: preferences.showUnreadOnly,
      toggleShowUnreadOnly,
      setShowUnreadOnly,
    }),
    [preferences.showUnreadOnly, toggleShowUnreadOnly, setShowUnreadOnly]
  );
}
