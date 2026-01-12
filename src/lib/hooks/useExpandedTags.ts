"use client";

import { useState, useCallback, useSyncExternalStore } from "react";

/**
 * useExpandedTags Hook
 *
 * Manages the expanded/collapsed state of tags in the sidebar.
 * State is persisted to localStorage.
 */

const STORAGE_KEY = "lion-reader-expanded-tags";

/**
 * Cached snapshots to avoid infinite loops per React requirements.
 * getSnapshot must return the same reference if the data hasn't changed.
 */
let cachedSnapshot: Set<string> | null = null;
let cachedStorageValue: string | null = null;

/**
 * Read expanded tag IDs from localStorage.
 * Returns cached value if localStorage hasn't changed.
 */
function getSnapshot(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    // Return cached snapshot if storage value hasn't changed
    if (stored === cachedStorageValue && cachedSnapshot !== null) {
      return cachedSnapshot;
    }
    cachedStorageValue = stored;
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        cachedSnapshot = new Set(parsed);
        return cachedSnapshot;
      }
    }
    cachedSnapshot = new Set();
    return cachedSnapshot;
  } catch (error) {
    console.error("Failed to parse expanded tags from localStorage:", error);
    if (cachedSnapshot === null) {
      cachedSnapshot = new Set();
    }
    return cachedSnapshot;
  }
}

/**
 * Server snapshot - always empty to match SSR.
 * Must be cached to avoid infinite loop per React requirements.
 */
const SERVER_SNAPSHOT = new Set<string>();
function getServerSnapshot(): Set<string> {
  return SERVER_SNAPSHOT;
}

/**
 * Subscribe to storage changes (for cross-tab sync).
 * Invalidates the cache when storage changes.
 */
function subscribe(callback: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      // Invalidate cache so next getSnapshot reads fresh value
      cachedStorageValue = null;
      callback();
    }
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}

export interface UseExpandedTagsResult {
  /** Set of currently expanded tag IDs (includes "uncategorized" as a special key) */
  expandedTagIds: Set<string>;
  /** Toggle a tag's expanded state */
  toggleExpanded: (tagId: string) => void;
  /** Check if a tag is expanded */
  isExpanded: (tagId: string) => boolean;
}

export function useExpandedTags(): UseExpandedTagsResult {
  // Use useSyncExternalStore for SSR-safe localStorage access
  // This returns server snapshot during SSR and client snapshot after hydration
  const storedIds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Local state to track optimistic updates before they're persisted
  const [localIds, setLocalIds] = useState<Set<string> | null>(null);

  // Use local state if set, otherwise use stored state
  const expandedTagIds = localIds ?? storedIds;

  const toggleExpanded = useCallback(
    (tagId: string) => {
      setLocalIds((prev) => {
        const current = prev ?? storedIds;
        const next = new Set(current);
        if (next.has(tagId)) {
          next.delete(tagId);
        } else {
          next.add(tagId);
        }

        // Persist to localStorage and invalidate cache
        try {
          const serialized = JSON.stringify(Array.from(next));
          localStorage.setItem(STORAGE_KEY, serialized);
          // Update cache to match what we just wrote
          cachedStorageValue = serialized;
          cachedSnapshot = next;
        } catch (error) {
          console.error("Failed to save expanded tags to localStorage:", error);
        }

        return next;
      });
    },
    [storedIds]
  );

  const isExpanded = useCallback(
    (tagId: string) => {
      return expandedTagIds.has(tagId);
    },
    [expandedTagIds]
  );

  return {
    expandedTagIds,
    toggleExpanded,
    isExpanded,
  };
}
