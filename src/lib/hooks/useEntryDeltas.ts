/**
 * useEntryDeltas Hook
 *
 * Shared hook for merging server entry data with Zustand deltas.
 * Used by EntryContent to apply optimistic updates for all entry types.
 *
 * The Zustand store tracks deltas (differences from server state), not copies.
 * This hook merges those deltas with server data at render time for instant UI updates.
 */

"use client";

import { useMemo } from "react";
import { useRealtimeStore } from "@/lib/store/realtime";

/**
 * Base entry data required for delta merging.
 * Both entries and saved articles have these fields.
 */
interface BaseEntryData {
  id: string;
  read: boolean;
  starred: boolean;
}

/**
 * Hook that merges a single entry with Zustand deltas.
 *
 * Use this for detail views (EntryContent) where you're displaying
 * a single entry and need optimistic updates.
 *
 * @param entry - Server entry data (or null if loading)
 * @returns Entry with deltas merged, or null if entry is null
 *
 * @example
 * ```tsx
 * const { data } = trpc.entries.get.useQuery({ id: entryId });
 * const entry = useEntryWithDeltas(data?.entry ?? null);
 * // entry.read and entry.starred reflect optimistic updates
 * ```
 */
export function useEntryWithDeltas<T extends BaseEntryData>(entry: T | null): T | null {
  const readIds = useRealtimeStore((s) => s.readIds);
  const unreadIds = useRealtimeStore((s) => s.unreadIds);
  const starredIds = useRealtimeStore((s) => s.starredIds);
  const unstarredIds = useRealtimeStore((s) => s.unstarredIds);

  return useMemo(() => {
    if (!entry) return null;

    // Apply read state deltas
    let read = entry.read;
    if (readIds.has(entry.id)) read = true;
    else if (unreadIds.has(entry.id)) read = false;

    // Apply starred state deltas
    let starred = entry.starred;
    if (starredIds.has(entry.id)) starred = true;
    else if (unstarredIds.has(entry.id)) starred = false;

    return { ...entry, read, starred };
  }, [entry, readIds, unreadIds, starredIds, unstarredIds]);
}

/**
 * Filter options for entry lists.
 */
export interface EntryFilterOptions {
  /**
   * Show only unread entries.
   */
  unreadOnly?: boolean;

  /**
   * Show only starred entries.
   */
  starredOnly?: boolean;
}

/**
 * Hook that merges a list of entries with Zustand deltas and optionally filters.
 *
 * Use this for list views (EntryList) where you're displaying multiple
 * entries and need optimistic updates with filter support.
 *
 * The filter is applied AFTER merging deltas, so marking an entry as read
 * in an "unread only" view will instantly hide it from the list.
 *
 * @param entries - Server entries array
 * @param filters - Optional filter options (unreadOnly, starredOnly)
 * @returns Entries with deltas merged and filters applied
 *
 * @example
 * ```tsx
 * const { data } = trpc.entries.list.useQuery({ ... });
 * const entries = useMergedEntries(data?.items ?? [], { unreadOnly: true });
 * // entries reflect optimistic updates and are filtered
 * ```
 */
export function useMergedEntries<T extends BaseEntryData>(
  entries: T[],
  filters?: EntryFilterOptions
): T[] {
  const readIds = useRealtimeStore((s) => s.readIds);
  const unreadIds = useRealtimeStore((s) => s.unreadIds);
  const starredIds = useRealtimeStore((s) => s.starredIds);
  const unstarredIds = useRealtimeStore((s) => s.unstarredIds);

  // Extract filter values as primitives for stable deps
  // (callers often pass inline objects like { unreadOnly: true } which create new references)
  const unreadOnly = filters?.unreadOnly;
  const starredOnly = filters?.starredOnly;

  return useMemo(() => {
    return entries
      .map((entry) => {
        // Apply read state deltas
        let read = entry.read;
        if (readIds.has(entry.id)) read = true;
        else if (unreadIds.has(entry.id)) read = false;

        // Apply starred state deltas
        let starred = entry.starred;
        if (starredIds.has(entry.id)) starred = true;
        else if (unstarredIds.has(entry.id)) starred = false;

        return { ...entry, read, starred };
      })
      .filter((entry) => {
        // Filter out entries that no longer match the view criteria after applying deltas
        if (unreadOnly && entry.read) {
          return false;
        }
        if (starredOnly && !entry.starred) {
          return false;
        }
        return true;
      });
  }, [entries, readIds, unreadIds, starredIds, unstarredIds, unreadOnly, starredOnly]);
}
