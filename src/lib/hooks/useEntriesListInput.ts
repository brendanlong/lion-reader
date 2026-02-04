/**
 * useEntriesListInput Hook
 *
 * Returns the query input for entries.list based on current URL state.
 * Ensures consistent query keys between components that need to share cache.
 */

"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useUrlViewPreferences } from "./useUrlViewPreferences";
import { buildEntriesListInput, type EntriesListInput } from "@/lib/queries/entries-list-input";
import { type EntryType } from "./useEntryMutations";

/**
 * Route filters derived from the current pathname.
 */
interface RouteFilters {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  starredOnly?: boolean;
  type?: EntryType;
}

/**
 * Extract route filters from pathname.
 */
function getFiltersFromPathname(pathname: string): RouteFilters {
  // /subscription/:id
  const subscriptionMatch = pathname.match(/^\/subscription\/([^/]+)/);
  if (subscriptionMatch) {
    return { subscriptionId: subscriptionMatch[1] };
  }

  // /tag/:tagId
  const tagMatch = pathname.match(/^\/tag\/([^/]+)/);
  if (tagMatch) {
    const tagId = tagMatch[1];
    // Handle "uncategorized" pseudo-tag
    if (tagId === "uncategorized") {
      return { uncategorized: true };
    }
    return { tagId };
  }

  // /starred
  if (pathname === "/starred") {
    return { starredOnly: true };
  }

  // /saved
  if (pathname === "/saved") {
    return { type: "saved" as const };
  }

  // /uncategorized
  if (pathname === "/uncategorized") {
    return { uncategorized: true };
  }

  // /all or default
  return {};
}

/**
 * Hook that returns the query input for entries.list based on current URL state.
 *
 * This ensures consistent query keys between:
 * - The suspending entry list component (for fetching)
 * - The parent component (for navigation/cache reading)
 *
 * @returns The query input object for entries.list
 */
export function useEntriesListInput(): EntriesListInput {
  const pathname = usePathname();
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  return useMemo(() => {
    const filters = getFiltersFromPathname(pathname);
    return buildEntriesListInput(filters, { unreadOnly: showUnreadOnly, sortOrder });
  }, [pathname, showUnreadOnly, sortOrder]);
}
