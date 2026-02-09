/**
 * Entry Navigation Context
 *
 * Shares entry list navigation state (next/previous entry IDs) between
 * SuspendingEntryList (which knows the entry ordering) and
 * UnifiedEntriesContent (which needs it for swipe gesture navigation
 * in the entry content view).
 *
 * Uses a ref + callback pattern to avoid unnecessary re-renders:
 * - SuspendingEntryList writes to the ref whenever entries change
 * - UnifiedEntriesContent subscribes via onChange callback
 */

"use client";

import { createContext, useContext, useCallback, useSyncExternalStore } from "react";

interface EntryNavigationState {
  nextEntryId: string | undefined;
  previousEntryId: string | undefined;
}

interface EntryNavigationStore {
  /** Get current navigation state */
  getSnapshot: () => EntryNavigationState;
  /** Subscribe to state changes */
  subscribe: (listener: () => void) => () => void;
  /** Update navigation state (called by SuspendingEntryList) */
  update: (state: EntryNavigationState) => void;
}

const defaultState: EntryNavigationState = {
  nextEntryId: undefined,
  previousEntryId: undefined,
};

export function createEntryNavigationStore(): EntryNavigationStore {
  let state = defaultState;
  const listeners = new Set<() => void>();

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update: (newState) => {
      // Only notify if state actually changed
      if (
        state.nextEntryId !== newState.nextEntryId ||
        state.previousEntryId !== newState.previousEntryId
      ) {
        state = newState;
        for (const listener of listeners) {
          listener();
        }
      }
    },
  };
}

const EntryNavigationContext = createContext<EntryNavigationStore | null>(null);

export const EntryNavigationProvider = EntryNavigationContext.Provider;

/**
 * Subscribe to entry navigation state changes.
 * Used by UnifiedEntriesContentInner for swipe gesture navigation.
 */
// No-op store used when context is not provided (avoids conditional hook call)
const noopStore: EntryNavigationStore = {
  getSnapshot: () => defaultState,
  subscribe: () => () => {},
  update: () => {},
};

export function useEntryNavigationState(): EntryNavigationState {
  const store = useContext(EntryNavigationContext) ?? noopStore;
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => defaultState);
}

/**
 * Get the navigation state updater.
 * Used by SuspendingEntryList to publish navigation state.
 */
export function useEntryNavigationUpdater(): (state: EntryNavigationState) => void {
  const store = useContext(EntryNavigationContext);
  return useCallback(
    (state: EntryNavigationState) => {
      store?.update(state);
    },
    [store]
  );
}
