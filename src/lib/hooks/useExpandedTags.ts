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
 * Read expanded tag IDs from localStorage.
 */
function getSnapshot(): Set<string> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        return new Set(parsed);
      }
    }
  } catch (error) {
    console.error("Failed to parse expanded tags from localStorage:", error);
  }
  return new Set();
}

/**
 * Server snapshot - always empty to match SSR.
 */
function getServerSnapshot(): Set<string> {
  return new Set();
}

/**
 * Subscribe to storage changes (for cross-tab sync).
 */
function subscribe(callback: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
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

        // Persist to localStorage
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(next)));
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
