/**
 * useEntryUrlState Hook
 *
 * Manages entry viewing state synchronized with URL query parameters.
 * When an entry is opened, the URL updates to include `?entry=entryId`,
 * allowing the page to be refreshed or shared while preserving state.
 */

"use client";

import { useCallback, useMemo } from "react";
import { clientPush, clientReplace } from "@/lib/navigation";
import { useAppHref, useAppPathname, useAppSearchParams } from "./useAppLocation";

/**
 * Marker stamped onto the history entry that opening an entry pushed, so
 * `closeEntry` can pop that entry instead of stranding it.
 *
 * It lives in history state rather than a ref because the hook is instantiated
 * per component: the instance that opens an entry (the list) is not the one
 * that closes it (the reader), so a per-instance ref is always false where it
 * is read, and closing would silently replace — leaving a dead history entry
 * that made the user's next Back press look like a no-op.
 */
const ENTRY_OPENED_STATE = { entryOpened: true };

/** Whether the current history entry is one we pushed to open an entry. */
function isEntryOpenedHistoryEntry(): boolean {
  if (typeof window === "undefined") return false;
  const state: unknown = window.history.state;
  return (
    typeof state === "object" &&
    state !== null &&
    (state as { entryOpened?: unknown }).entryOpened === true
  );
}

export interface UseEntryUrlStateResult {
  /** The currently open entry ID, or null if no entry is open */
  openEntryId: string | null;
  /** Set the open entry ID (updates the URL) */
  setOpenEntryId: (entryId: string | null) => void;
  /** Close the entry (removes from URL) */
  closeEntry: () => void;
  /** The browser href that opens `entryId` in the current view (for real `<a>` links) */
  entryHref: (entryId: string) => string;
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
  const searchParams = useAppSearchParams();
  const pathname = useAppPathname();
  const appHref = useAppHref();

  // Get the current entry ID from the URL
  const openEntryId = useMemo(() => {
    return searchParams.get("entry");
  }, [searchParams]);

  // The current view's URL with `entry` set (or removed)
  const buildEntryUrl = useCallback(
    (entryId: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (entryId) {
        params.set("entry", entryId);
      } else {
        params.delete("entry");
      }
      const queryString = params.toString();
      return appHref(queryString ? `${pathname}?${queryString}` : pathname);
    },
    [searchParams, pathname, appHref]
  );

  // Update the URL with a new entry ID (or remove it)
  const setOpenEntryId = useCallback(
    (entryId: string | null) => {
      const currentEntryId = searchParams.get("entry");
      const newUrl = buildEntryUrl(entryId);

      // Use push when opening an entry from the list (null -> entryId)
      // This adds the entry view to browser history, so back gesture returns to list
      // Use replace when navigating between entries to avoid history bloat
      if (entryId && !currentEntryId) {
        // Opening an entry from list view - add to history
        clientPush(newUrl, ENTRY_OPENED_STATE);
      } else if (entryId) {
        // Navigating between entries - replace to avoid history bloat, but keep
        // the marker so closing still pops the entry that opening pushed.
        clientReplace(newUrl, isEntryOpenedHistoryEntry() ? ENTRY_OPENED_STATE : null);
      } else {
        // Closing without popping (no pushed entry to return to)
        clientReplace(newUrl);
      }
    },
    [searchParams, buildEntryUrl]
  );

  // Close the entry - uses history.back() if we pushed when opening, to preserve React state
  // This makes "Back to list" behave identically to the browser back button
  const closeEntry = useCallback(() => {
    if (isEntryOpenedHistoryEntry()) {
      window.history.back();
    } else {
      setOpenEntryId(null);
    }
  }, [setOpenEntryId]);

  return {
    openEntryId,
    setOpenEntryId,
    closeEntry,
    entryHref: buildEntryUrl,
  };
}
