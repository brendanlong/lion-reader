/**
 * DemoStateContext
 *
 * Client-side state management for the demo pages.
 * Manages mutable read/starred status for demo entries,
 * plus view preferences (sort order, unread-only filter).
 * State is non-durable (resets on page reload).
 */

"use client";

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { DEMO_ENTRIES, type DemoEntry } from "./data";

// ============================================================================
// Types
// ============================================================================

interface EntryState {
  read: boolean;
  starred: boolean;
}

interface DemoState {
  /** Per-entry read/starred overrides keyed by entry ID */
  entryStates: Map<string, EntryState>;

  /** Current sort order */
  sortOrder: "newest" | "oldest";

  /** Whether to show only unread entries */
  showUnreadOnly: boolean;
}

interface DemoStateContextValue {
  /** Get the current state of an entry (with overrides applied) */
  getEntryState: (entryId: string) => EntryState;

  /** Toggle read status for an entry */
  toggleRead: (entryId: string) => void;

  /** Toggle starred status for an entry */
  toggleStar: (entryId: string) => void;

  /** Set read status for an entry (non-toggle, explicit value) */
  markRead: (entryId: string, read: boolean) => void;

  /** Mark all provided entries as read */
  markAllRead: (entryIds: string[]) => void;

  /** Current sort order */
  sortOrder: "newest" | "oldest";

  /** Toggle sort order */
  toggleSortOrder: () => void;

  /** Whether to show only unread entries */
  showUnreadOnly: boolean;

  /** Toggle unread-only filter */
  toggleShowUnreadOnly: () => void;

  /** Apply current state overrides to a list of entries and return filtered/sorted results */
  applyState: (entries: DemoEntry[]) => DemoEntry[];

  /** Count unread entries from a list (with state applied) */
  countUnread: (entries: DemoEntry[]) => number;

  /** Get all currently-starred entries (with state applied) */
  getStarredEntries: () => DemoEntry[];

  /** Count unread starred entries (for sidebar Highlights count) */
  countUnreadStarred: () => number;
}

// ============================================================================
// Context
// ============================================================================

const DemoStateContext = createContext<DemoStateContextValue | null>(null);

// ============================================================================
// Provider
// ============================================================================

export function DemoStateProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DemoState>(() => {
    // Initialize from static data defaults
    const entryStates = new Map<string, EntryState>();
    for (const entry of DEMO_ENTRIES) {
      entryStates.set(entry.id, { read: entry.read, starred: entry.starred });
    }
    return {
      entryStates,
      sortOrder: "newest",
      showUnreadOnly: false,
    };
  });

  const getEntryState = useCallback(
    (entryId: string): EntryState => {
      return state.entryStates.get(entryId) ?? { read: false, starred: false };
    },
    [state.entryStates]
  );

  const toggleRead = useCallback((entryId: string) => {
    setState((prev) => {
      const newStates = new Map(prev.entryStates);
      const current = newStates.get(entryId) ?? { read: false, starred: false };
      newStates.set(entryId, { ...current, read: !current.read });
      return { ...prev, entryStates: newStates };
    });
  }, []);

  const toggleStar = useCallback((entryId: string) => {
    setState((prev) => {
      const newStates = new Map(prev.entryStates);
      const current = newStates.get(entryId) ?? { read: false, starred: false };
      newStates.set(entryId, { ...current, starred: !current.starred });
      return { ...prev, entryStates: newStates };
    });
  }, []);

  const markRead = useCallback((entryId: string, read: boolean) => {
    setState((prev) => {
      const newStates = new Map(prev.entryStates);
      const current = newStates.get(entryId) ?? { read: false, starred: false };
      newStates.set(entryId, { ...current, read });
      return { ...prev, entryStates: newStates };
    });
  }, []);

  const markAllRead = useCallback((entryIds: string[]) => {
    setState((prev) => {
      const newStates = new Map(prev.entryStates);
      for (const id of entryIds) {
        const current = newStates.get(id) ?? { read: false, starred: false };
        newStates.set(id, { ...current, read: true });
      }
      return { ...prev, entryStates: newStates };
    });
  }, []);

  const toggleSortOrder = useCallback(() => {
    setState((prev) => ({
      ...prev,
      sortOrder: prev.sortOrder === "newest" ? "oldest" : "newest",
    }));
  }, []);

  const toggleShowUnreadOnly = useCallback(() => {
    setState((prev) => ({
      ...prev,
      showUnreadOnly: !prev.showUnreadOnly,
    }));
  }, []);

  const applyState = useCallback(
    (entries: DemoEntry[]): DemoEntry[] => {
      // Apply read/starred overrides
      let result = entries.map((entry) => {
        const entryState = state.entryStates.get(entry.id);
        if (!entryState) return entry;
        return { ...entry, read: entryState.read, starred: entryState.starred };
      });

      // Filter unread only
      if (state.showUnreadOnly) {
        result = result.filter((e) => !e.read);
      }

      // Sort
      result = [...result].sort((a, b) => {
        const timeA = a.publishedAt?.getTime() ?? 0;
        const timeB = b.publishedAt?.getTime() ?? 0;
        return state.sortOrder === "newest" ? timeB - timeA : timeA - timeB;
      });

      return result;
    },
    [state.entryStates, state.showUnreadOnly, state.sortOrder]
  );

  const countUnread = useCallback(
    (entries: DemoEntry[]): number => {
      return entries.filter((e) => {
        const entryState = state.entryStates.get(e.id);
        return entryState ? !entryState.read : !e.read;
      }).length;
    },
    [state.entryStates]
  );

  const getStarredEntries = useCallback((): DemoEntry[] => {
    return DEMO_ENTRIES.filter((e) => {
      const entryState = state.entryStates.get(e.id);
      return entryState ? entryState.starred : e.starred;
    }).map((entry) => {
      const entryState = state.entryStates.get(entry.id);
      if (!entryState) return entry;
      return { ...entry, read: entryState.read, starred: entryState.starred };
    });
  }, [state.entryStates]);

  const countUnreadStarred = useCallback((): number => {
    return DEMO_ENTRIES.filter((e) => {
      const entryState = state.entryStates.get(e.id);
      const starred = entryState ? entryState.starred : e.starred;
      const read = entryState ? entryState.read : e.read;
      return starred && !read;
    }).length;
  }, [state.entryStates]);

  const value = useMemo<DemoStateContextValue>(
    () => ({
      getEntryState,
      toggleRead,
      toggleStar,
      markRead,
      markAllRead,
      sortOrder: state.sortOrder,
      toggleSortOrder,
      showUnreadOnly: state.showUnreadOnly,
      toggleShowUnreadOnly,
      applyState,
      countUnread,
      getStarredEntries,
      countUnreadStarred,
    }),
    [
      getEntryState,
      toggleRead,
      toggleStar,
      markRead,
      markAllRead,
      state.sortOrder,
      toggleSortOrder,
      state.showUnreadOnly,
      toggleShowUnreadOnly,
      applyState,
      countUnread,
      getStarredEntries,
      countUnreadStarred,
    ]
  );

  return <DemoStateContext.Provider value={value}>{children}</DemoStateContext.Provider>;
}

// ============================================================================
// Hook
// ============================================================================

export function useDemoState(): DemoStateContextValue {
  const ctx = useContext(DemoStateContext);
  if (!ctx) {
    throw new Error("useDemoState must be used within a DemoStateProvider");
  }
  return ctx;
}
