/**
 * useOpenEntry Hook
 *
 * Wraps useEntryUrlState with pre-emptive mark-read mutation for auto-mark-read.
 * When opening an unread entry, fires the markRead mutation BEFORE updating the URL,
 * so the optimistic update takes effect before the entry component even mounts.
 *
 * This eliminates the flash where entries briefly show as unread.
 */

"use client";

import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useEntryUrlState, type UseEntryUrlStateResult } from "./useEntryUrlState";
import { useEntryMutations } from "./useEntryMutations";
import { findEntryInListCache } from "@/lib/cache/entry-cache";

export interface UseOpenEntryResult extends UseEntryUrlStateResult {
  /**
   * Open an entry, firing the mark-read mutation before navigation.
   * This is the preferred way to open entries - use this instead of setOpenEntryId
   * when opening an entry should mark it as read.
   */
  openEntry: (entryId: string) => void;
}

/**
 * Hook for opening entries with pre-emptive mark-read mutations.
 *
 * When an entry is opened, this hook:
 * 1. Checks if the entry is currently unread (from cache)
 * 2. If unread, fires the markRead mutation (with optimistic update)
 * 3. Updates the URL to show the entry
 *
 * By firing the mutation before updating the URL, the optimistic update takes
 * effect before EntryContent/EntryContentFallback mount, eliminating the flash
 * where entries briefly show as unread.
 *
 * Since we fire the mutation here, EntryContent's auto-mark-read effect will
 * see the entry as already read and skip firing a duplicate mutation.
 *
 * @example
 * ```tsx
 * const { openEntryId, openEntry, closeEntry } = useOpenEntry();
 *
 * // Open an entry (fires mutation, then updates URL)
 * openEntry("123");
 *
 * // For navigation between already-open entries, openEntry handles it
 * openEntry("456");
 * ```
 */
export function useOpenEntry(): UseOpenEntryResult {
  const urlState = useEntryUrlState();
  const queryClient = useQueryClient();
  const { markRead } = useEntryMutations();

  const openEntry = useCallback(
    (entryId: string) => {
      // Check if the entry is currently unread in the cache
      // We look in the list cache since that's what EntryContentFallback uses
      const cachedEntry = findEntryInListCache(queryClient, entryId);

      // If entry is unread, fire the markRead mutation
      // The mutation's onMutate will optimistically update the cache immediately,
      // and onError will roll back if the server request fails
      if (cachedEntry && !cachedEntry.read) {
        markRead([entryId], true);
      }

      // Update the URL - the optimistic update has already happened synchronously
      // in markRead's onMutate, so EntryContentFallback will see read=true
      urlState.setOpenEntryId(entryId);
    },
    [queryClient, markRead, urlState]
  );

  return {
    ...urlState,
    openEntry,
  };
}
