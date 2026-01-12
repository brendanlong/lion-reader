/**
 * useUrlViewPreferences Hook
 *
 * Manages view preferences (unreadOnly, sortOrder) synced to URL query params.
 * This enables:
 * - Server-side prefetching with correct filters
 * - Shareable/bookmarkable filtered views
 * - Browser back/forward navigation through filter changes
 *
 * Falls back to localStorage defaults when URL params are not present.
 */

"use client";

import { useCallback, useMemo } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { getViewPreferences, type ViewType } from "./viewPreferences";

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
}

/**
 * Parse view preferences from URL search params.
 * Falls back to localStorage defaults if not specified in URL.
 */
export function parseViewPreferencesFromParams(
  searchParams: URLSearchParams | null,
  viewType: ViewType,
  viewId?: string
): { unreadOnly: boolean; sortOrder: "newest" | "oldest" } {
  const defaults = getViewPreferences(viewType, viewId);

  // Parse unreadOnly - explicit "false" means show all, anything else uses default
  const unreadOnlyParam = searchParams?.get("unreadOnly");
  const unreadOnly =
    unreadOnlyParam === "false"
      ? false
      : unreadOnlyParam === "true"
        ? true
        : defaults.showUnreadOnly;

  // Parse sortOrder - explicit "oldest" means oldest first, anything else uses default
  const sortParam = searchParams?.get("sort");
  const sortOrder =
    sortParam === "oldest" ? "oldest" : sortParam === "newest" ? "newest" : defaults.sortOrder;

  return { unreadOnly, sortOrder };
}

/**
 * Hook for managing view preferences synced to URL query params.
 *
 * @param viewType - The type of view (for localStorage fallback defaults)
 * @param viewId - Optional ID for feed or tag views
 * @returns View preferences and toggle functions
 *
 * @example
 * ```tsx
 * function AllEntriesPage() {
 *   const { showUnreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder } =
 *     useUrlViewPreferences('all');
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
export function useUrlViewPreferences(
  viewType: ViewType,
  viewId?: string
): UseUrlViewPreferencesResult {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Get current values from URL (with localStorage fallback)
  const { unreadOnly, sortOrder } = useMemo(
    () => parseViewPreferencesFromParams(searchParams, viewType, viewId),
    [searchParams, viewType, viewId]
  );

  // Helper to update URL with new params
  const updateUrl = useCallback(
    (updates: { unreadOnly?: boolean; sort?: "newest" | "oldest" }) => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");

      // Update unreadOnly param
      if (updates.unreadOnly !== undefined) {
        if (updates.unreadOnly) {
          // true is the default, remove from URL to keep it clean
          params.delete("unreadOnly");
        } else {
          params.set("unreadOnly", "false");
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
      router.replace(url, { scroll: false });
    },
    [router, pathname, searchParams]
  );

  const toggleShowUnreadOnly = useCallback(() => {
    updateUrl({ unreadOnly: !unreadOnly });
  }, [updateUrl, unreadOnly]);

  const toggleSortOrder = useCallback(() => {
    updateUrl({ sort: sortOrder === "newest" ? "oldest" : "newest" });
  }, [updateUrl, sortOrder]);

  return useMemo(
    () => ({
      showUnreadOnly: unreadOnly,
      toggleShowUnreadOnly,
      sortOrder,
      toggleSortOrder,
    }),
    [unreadOnly, toggleShowUnreadOnly, sortOrder, toggleSortOrder]
  );
}
