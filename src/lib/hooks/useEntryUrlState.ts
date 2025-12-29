/**
 * useEntryUrlState Hook
 *
 * Manages entry viewing state synchronized with URL query parameters.
 * When an entry is opened, the URL updates to include `?entry=entryId`,
 * allowing the page to be refreshed or shared while preserving state.
 */

"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";

export interface UseEntryUrlStateResult {
  /** The currently open entry ID, or null if no entry is open */
  openEntryId: string | null;
  /** Set the open entry ID (updates the URL) */
  setOpenEntryId: (entryId: string | null) => void;
  /** Close the entry (removes from URL) */
  closeEntry: () => void;
}

/**
 * Hook for managing entry viewing state via URL query parameters.
 *
 * This enables:
 * - Refreshing the page without losing the current entry view
 * - Browser back/forward navigation between entries
 * - Shareable URLs that link directly to an entry
 *
 * @example
 * ```tsx
 * const { openEntryId, setOpenEntryId, closeEntry } = useEntryUrlState();
 *
 * // Open an entry (updates URL to ?entry=123)
 * setOpenEntryId("123");
 *
 * // Close the entry (removes ?entry from URL)
 * closeEntry();
 * ```
 */
export function useEntryUrlState(): UseEntryUrlStateResult {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get the current entry ID from the URL
  const openEntryId = useMemo(() => {
    return searchParams.get("entry");
  }, [searchParams]);

  // Update the URL with a new entry ID (or remove it)
  const setOpenEntryId = useCallback(
    (entryId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());

      if (entryId) {
        params.set("entry", entryId);
      } else {
        params.delete("entry");
      }

      const queryString = params.toString();
      const newUrl = queryString ? `${pathname}?${queryString}` : pathname;

      // Use replace to avoid adding to browser history for every entry click
      // Users can still use back button to go from entry view to list
      router.replace(newUrl, { scroll: false });
    },
    [searchParams, pathname, router]
  );

  // Convenience function to close the entry
  const closeEntry = useCallback(() => {
    setOpenEntryId(null);
  }, [setOpenEntryId]);

  return {
    openEntryId,
    setOpenEntryId,
    closeEntry,
  };
}
