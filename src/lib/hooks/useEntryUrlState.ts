/**
 * useEntryUrlState Hook
 *
 * Manages entry viewing state synchronized with URL query parameters.
 * When an entry is opened, the URL updates to include `?entry=entryId`,
 * allowing the page to be refreshed or shared while preserving state.
 */

"use client";

import { useCallback, useMemo, useRef } from "react";
import { useSearchParams, usePathname } from "next/navigation";
import { clientPush, clientReplace } from "@/lib/navigation";

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
  const pathname = usePathname();

  // Track whether we pushed to history when opening an entry
  // This allows us to use history.back() when closing, which preserves React state
  const pushedToHistoryRef = useRef(false);

  // Get the current entry ID from the URL
  const openEntryId = useMemo(() => {
    return searchParams.get("entry");
  }, [searchParams]);

  // Update the URL with a new entry ID (or remove it)
  const setOpenEntryId = useCallback(
    (entryId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      const currentEntryId = searchParams.get("entry");

      if (entryId) {
        params.set("entry", entryId);
      } else {
        params.delete("entry");
      }

      const queryString = params.toString();
      const newUrl = queryString ? `${pathname}?${queryString}` : pathname;

      // Use push when opening an entry from the list (null -> entryId)
      // This adds the entry view to browser history, so back gesture returns to list
      // Use replace when navigating between entries to avoid history bloat
      if (entryId && !currentEntryId) {
        // Opening an entry from list view - add to history
        pushedToHistoryRef.current = true;
        clientPush(newUrl);
      } else {
        // Navigating between entries or closing - replace to avoid history bloat
        clientReplace(newUrl);
      }
    },
    [searchParams, pathname]
  );

  // Close the entry - uses history.back() if we pushed when opening, to preserve React state
  // This makes "Back to list" behave identically to the browser back button
  const closeEntry = useCallback(() => {
    if (pushedToHistoryRef.current && typeof window !== "undefined") {
      pushedToHistoryRef.current = false;
      window.history.back();
    } else {
      setOpenEntryId(null);
    }
  }, [setOpenEntryId]);

  return {
    openEntryId,
    setOpenEntryId,
    closeEntry,
  };
}
