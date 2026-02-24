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
