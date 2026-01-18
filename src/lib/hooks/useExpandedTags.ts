"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * useExpandedTags Hook
 *
 * Manages the expanded/collapsed state of tags in the sidebar.
 * State is persisted to localStorage.
 *
 * Uses useSyncExternalStore to avoid hydration mismatches - the server
 * always renders with all tags collapsed, and the client reads from
 * localStorage after hydration.
 */

const STORAGE_KEY = "lion-reader-expanded-tags";

export interface UseExpandedTagsResult {
  /** Set of currently expanded tag IDs (includes "uncategorized" as a special key) */
  expandedTagIds: Set<string>;
  /** Toggle a tag's expanded state */
  toggleExpanded: (tagId: string) => void;
  /** Check if a tag is expanded */
  isExpanded: (tagId: string) => boolean;
}

// In-memory cache to avoid re-parsing localStorage on every subscription
let cachedExpandedTagIds: Set<string> | null = null;
let listeners: Array<() => void> = [];

function getExpandedTagIds(): Set<string> {
  if (cachedExpandedTagIds !== null) {
    return cachedExpandedTagIds;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        cachedExpandedTagIds = new Set(parsed);
        return cachedExpandedTagIds;
      }
    }
  } catch (error) {
    console.error("Failed to parse expanded tags from localStorage:", error);
  }

  cachedExpandedTagIds = new Set();
  return cachedExpandedTagIds;
}

function setExpandedTagIds(newSet: Set<string>): void {
  cachedExpandedTagIds = newSet;

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(newSet)));
  } catch (error) {
    console.error("Failed to save expanded tags to localStorage:", error);
  }

  // Notify all subscribers
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

function getSnapshot(): Set<string> {
  return getExpandedTagIds();
}

// Server always returns empty set - all tags collapsed during SSR
const emptySet = new Set<string>();
function getServerSnapshot(): Set<string> {
  return emptySet;
}

export function useExpandedTags(): UseExpandedTagsResult {
  const expandedTagIds = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const toggleExpanded = useCallback((tagId: string) => {
    const current = getExpandedTagIds();
    const next = new Set(current);
    if (next.has(tagId)) {
      next.delete(tagId);
    } else {
      next.add(tagId);
    }
    setExpandedTagIds(next);
  }, []);

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
