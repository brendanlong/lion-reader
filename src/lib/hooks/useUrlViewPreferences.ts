/**
 * useUrlViewPreferences Hook
 *
 * Manages view preferences (unreadOnly, sortOrder) synced to URL query params.
 * This enables:
 * - Server-side prefetching with correct filters
 * - Shareable/bookmarkable filtered views
 * - Browser back/forward navigation through filter changes
 * - No hydration mismatches (server and client render the same state)
 *
 * Uses DEFAULT_PREFERENCES when URL params are not present.
 */

"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { clientPush, clientReplace } from "@/lib/navigation";
import { parseViewPreferencesFromParams } from "./viewPreferences";
import { getDefaultViewPreferences } from "@/lib/queries/entries-list-input";

/**
 * Result of the useUrlViewPreferences hook.
 */
export interface UseUrlViewPreferencesResult {
  /**
   * Current preference: show only unread items.
   */
  showUnreadOnly: boolean;

  /**
   * Toggle the showUnreadOnly preference (updates URL).
   */
  toggleShowUnreadOnly: () => void;

  /**
   * Current preference: sort order for entries.
   */
  sortOrder: "newest" | "oldest";

  /**
   * Toggle the sortOrder preference (updates URL).
   */
  toggleSortOrder: () => void;

  /**
   * Active full-text search query (`?q=` URL param); undefined when not searching.
   */
  searchQuery: string | undefined;

  /**
   * Set or clear the search query (updates URL). Pass null/empty to clear.
   */
  setSearchQuery: (query: string | null) => void;
}

/**
 * Hook for managing view preferences synced to URL query params.
 *
 * @returns View preferences and toggle functions
 *
 * @example
 * ```tsx
 * function AllEntriesPage() {
 *   const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
 *     useUrlViewPreferences();
 *
 *   // URL will update to /all?unreadOnly=false when toggled
 *   return (
 *     <button onClick={toggleShowUnreadOnly}>
 *       {showUnreadOnly ? 'Show all' : 'Show unread only'}
 *     </button>
 *   );
 * }
 * ```
 */
export function useUrlViewPreferences(): UseUrlViewPreferencesResult {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const routeDefaultUnreadOnly = getDefaultViewPreferences(pathname).unreadOnly;

  // Get current values from URL
  const { unreadOnly, sortOrder, searchQuery } = useMemo(
    () => parseViewPreferencesFromParams(searchParams, { unreadOnly: routeDefaultUnreadOnly }),
    [searchParams, routeDefaultUnreadOnly]
  );

  // While searching, the effective unreadOnly default flips to false (see
  // parseViewPreferencesFromParams) — use the same default when deciding
  // whether the param can be dropped from the URL.
  const defaultUnreadOnly = searchQuery ? false : routeDefaultUnreadOnly;

  // Helper to update URL with new params
  const updateUrl = useCallback(
    (updates: { unreadOnly?: boolean; sort?: "newest" | "oldest" }) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");

      // Update unreadOnly param
      if (updates.unreadOnly !== undefined) {
        if (updates.unreadOnly === defaultUnreadOnly) {
          // Matches the default for this view, remove from URL to keep it clean
          params.delete("unreadOnly");
        } else {
          params.set("unreadOnly", String(updates.unreadOnly));
        }
      }

      // Update sort param
      if (updates.sort !== undefined) {
        if (updates.sort === "newest") {
          // newest is the default, remove from URL to keep it clean
          params.delete("sort");
        } else {
          params.set("sort", updates.sort);
        }
      }

      const queryString = params.toString();
      const url = queryString ? `${pathname}?${queryString}` : pathname;
      clientReplace(url);
    },
    [pathname, searchParams, defaultUnreadOnly]
  );

  const toggleShowUnreadOnly = useCallback(() => {
    updateUrl({ unreadOnly: !unreadOnly });
  }, [updateUrl, unreadOnly]);

  const toggleSortOrder = useCallback(() => {
    updateUrl({ sort: sortOrder === "newest" ? "oldest" : "newest" });
  }, [updateUrl, sortOrder]);

  const setSearchQuery = useCallback(
    (query: string | null) => {
      const trimmed = query?.trim() ?? "";
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (trimmed) {
        params.set("q", trimmed);
      } else {
        params.delete("q");
      }
      const queryString = params.toString();
      const url = queryString ? `${pathname}?${queryString}` : pathname;
      // Entering a search pushes a history entry so Back exits the search;
      // refining or clearing one replaces, so each keystroke-level tweak
      // doesn't pile up in history.
      if (trimmed && !searchQuery) {
        clientPush(url);
      } else {
        clientReplace(url);
      }
    },
    [pathname, searchParams, searchQuery]
  );

  return useMemo(
    () => ({
      showUnreadOnly: unreadOnly,
      toggleShowUnreadOnly,
      sortOrder,
      toggleSortOrder,
      searchQuery,
      setSearchQuery,
    }),
    [unreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder, searchQuery, setSearchQuery]
  );
}
