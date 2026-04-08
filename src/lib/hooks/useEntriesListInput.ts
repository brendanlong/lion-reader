/**
 * useEntriesListInput Hook
 *
 * Returns the query input for entries.list based on current URL state.
 * Ensures consistent query keys between components that need to share cache.
 */

"use client";

import { useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useUrlViewPreferences } from "./useUrlViewPreferences";
import {
  buildEntriesListInput,
  getFiltersFromPathname,
  type EntriesListInput,
} from "@/lib/queries/entries-list-input";

/**
 * Hook that returns the query input for entries.list based on current URL state.
 *
 * This ensures consistent query keys between:
 * - The suspending entry list component (for fetching)
 * - The parent component (for navigation/cache reading)
 *
 * Reads the `q` search param for full-text search on the /search page.
 *
 * @returns The query input object for entries.list
 */
export function useEntriesListInput(): EntriesListInput {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { showUnreadOnly, sortOrder } = useUrlViewPreferences();

  return useMemo(() => {
    const filters = getFiltersFromPathname(pathname);

    // Read search query from URL params (used on /search page)
    const q = searchParams?.get("q")?.trim() || undefined;
    if (q) {
      filters.query = q;
    }

    return buildEntriesListInput(filters, { unreadOnly: showUnreadOnly, sortOrder });
  }, [pathname, searchParams, showUnreadOnly, sortOrder]);
}
