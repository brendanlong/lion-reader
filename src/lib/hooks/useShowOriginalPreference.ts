/**
 * useShowOriginalPreference Hook
 *
 * Manages user preference for showing original vs cleaned content per feed.
 * Persists preferences in localStorage keyed by feed ID.
 *
 * Uses useSyncExternalStore for proper React 18 concurrent mode support.
 */

"use client";

import { useSyncExternalStore, useCallback, useMemo } from "react";

/**
 * Generate localStorage key for a feed's show original preference.
 */
function getStorageKey(feedId: string): string {
  return `lion-reader:show-original:${feedId}`;
}

/**
 * Load show original preference from localStorage.
 */
function loadPreference(feedId: string): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    const stored = localStorage.getItem(getStorageKey(feedId));
    if (stored !== null) {
      return JSON.parse(stored) === true;
    }
  } catch {
    // Invalid JSON, use default
  }

  return false;
}

/**
 * Save show original preference to localStorage.
 */
function savePreference(feedId: string, showOriginal: boolean): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(getStorageKey(feedId), JSON.stringify(showOriginal));
  } catch {
    // Storage full or unavailable, ignore
  }
}

// Map of feedId to listeners for that feed's preference
const listeners = new Map<string, Set<() => void>>();

// Cache for snapshot values to avoid infinite loops with useSyncExternalStore
const snapshotCache = new Map<string, boolean>();

/**
 * Get cached snapshot, loading from localStorage if not cached.
 */
function getSnapshotCached(feedId: string): boolean {
  if (!snapshotCache.has(feedId)) {
    snapshotCache.set(feedId, loadPreference(feedId));
  }
  return snapshotCache.get(feedId)!;
}

/**
 * Update the cache and notify listeners.
 */
function updateCache(feedId: string, showOriginal: boolean): void {
  snapshotCache.set(feedId, showOriginal);
  savePreference(feedId, showOriginal);
  notifyListeners(feedId);
}

/**
 * Subscribe to preference changes for a specific feed.
 */
function subscribe(feedId: string, callback: () => void): () => void {
  if (!listeners.has(feedId)) {
    listeners.set(feedId, new Set());
  }
  listeners.get(feedId)!.add(callback);

  return () => {
    listeners.get(feedId)?.delete(callback);
    if (listeners.get(feedId)?.size === 0) {
      listeners.delete(feedId);
    }
  };
}

/**
 * Notify all listeners for a feed.
 */
function notifyListeners(feedId: string): void {
  listeners.get(feedId)?.forEach((callback) => callback());
}

/**
 * Hook for managing show original preference per feed with localStorage persistence.
 *
 * Uses useSyncExternalStore for proper React 18 concurrent mode support.
 *
 * @param feedId - The feed ID to store the preference for (can be undefined while loading)
 * @returns Tuple of [showOriginal, setShowOriginal]
 *
 * @example
 * ```tsx
 * function EntryContent({ entryId }: { entryId: string }) {
 *   const { data } = trpc.entries.get.useQuery({ id: entryId });
 *   const [showOriginal, setShowOriginal] = useShowOriginalPreference(data?.entry.feedId);
 *
 *   return (
 *     <ArticleContentBody
 *       showOriginal={showOriginal}
 *       setShowOriginal={setShowOriginal}
 *       // ...
 *     />
 *   );
 * }
 * ```
 */
export function useShowOriginalPreference(
  feedId: string | undefined
): [boolean, (value: boolean) => void] {
  // Create stable subscribe function for this feedId
  const subscribeToFeed = useCallback(
    (callback: () => void) => {
      if (!feedId) {
        // No feedId yet, return no-op unsubscribe
        return () => {};
      }
      return subscribe(feedId, callback);
    },
    [feedId]
  );

  // Create stable getSnapshot function that returns cached value
  const getSnapshot = useCallback(() => {
    if (!feedId) {
      return false;
    }
    return getSnapshotCached(feedId);
  }, [feedId]);

  // Server snapshot always returns default (false)
  const getServerSnapshot = useCallback(() => false, []);

  // Use useSyncExternalStore for React 18 concurrent mode support
  const showOriginal = useSyncExternalStore(subscribeToFeed, getSnapshot, getServerSnapshot);

  // Setter that updates cache and persists to localStorage
  const setShowOriginal = useCallback(
    (value: boolean) => {
      if (feedId) {
        updateCache(feedId, value);
      }
    },
    [feedId]
  );

  return useMemo(() => [showOriginal, setShowOriginal], [showOriginal, setShowOriginal]);
}
