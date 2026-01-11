"use client";

import { useState, useEffect } from "react";

/**
 * useExpandedTags Hook
 *
 * Manages the expanded/collapsed state of tags in the sidebar.
 * State is persisted to localStorage.
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

export function useExpandedTags(): UseExpandedTagsResult {
  // Use lazy initializer to avoid reading localStorage on every render
  const [expandedTagIds, setExpandedTagIds] = useState<Set<string>>(() => {
    // SSR safety check
    if (typeof window === "undefined") {
      return new Set();
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          return new Set(parsed);
        }
      }
    } catch (error) {
      // If localStorage contains invalid JSON, default to empty Set
      console.error("Failed to parse expanded tags from localStorage:", error);
    }

    return new Set();
  });

  // Persist to localStorage whenever state changes
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      const tagIdsArray = Array.from(expandedTagIds);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tagIdsArray));
    } catch (error) {
      console.error("Failed to save expanded tags to localStorage:", error);
    }
  }, [expandedTagIds]);

  const toggleExpanded = (tagId: string) => {
    setExpandedTagIds((prev) => {
      const next = new Set(prev);
      if (next.has(tagId)) {
        next.delete(tagId);
      } else {
        next.add(tagId);
      }
      return next;
    });
  };

  const isExpanded = (tagId: string) => {
    return expandedTagIds.has(tagId);
  };

  return {
    expandedTagIds,
    toggleExpanded,
    isExpanded,
  };
}
