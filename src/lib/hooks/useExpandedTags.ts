"use client";

import { useCallback } from "react";
import { createStoredJson } from "@/lib/stored-preference";

/**
 * The sidebar's expanded tag sections ("uncategorized" included), kept in
 * localStorage. Every section renders collapsed on the server.
 */
const expandedTags = createStoredJson<readonly string[]>("lion-reader-expanded-tags", [], (json) =>
  Array.isArray(json) ? json.filter((id): id is string => typeof id === "string") : null
);

function toggleExpanded(tagId: string): void {
  const ids = expandedTags.get();
  expandedTags.set(ids.includes(tagId) ? ids.filter((id) => id !== tagId) : [...ids, tagId]);
}

export function useExpandedTags(): {
  isExpanded: (tagId: string) => boolean;
  toggleExpanded: (tagId: string) => void;
} {
  const ids = expandedTags.useValue();
  const isExpanded = useCallback((tagId: string) => ids.includes(tagId), [ids]);
  return { isExpanded, toggleExpanded };
}
