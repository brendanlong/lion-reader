/**
 * Realtime Delta Store
 *
 * Zustand store that tracks client-side deltas (differences from server state).
 * This store does NOT duplicate server data - it only stores adjustments:
 * - Which entries are read/starred (Set of IDs)
 * - Count deltas for subscriptions/tags (positive or negative adjustments)
 * - Pending entries from SSE (not yet in server state)
 *
 * Components merge these deltas with server data at render time.
 * Deltas are reset on full refresh or when sync is lost.
 */

import { create } from "zustand";
import { devtools } from "zustand/middleware";

// Enable debug logging in development
const DEBUG = process.env.NODE_ENV === "development";

/**
 * Entry added via SSE that hasn't been fetched from server yet
 */
interface PendingEntry {
  id: string;
  subscriptionId: string;
  timestamp: string;
}

/**
 * Realtime delta store state
 */
interface RealtimeStore {
  // Entry state diffs (Sets for fast lookup and idempotency)
  readIds: Set<string>;
  unreadIds: Set<string>;
  starredIds: Set<string>;
  unstarredIds: Set<string>;

  // Track which entries we've seen via SSE (for idempotency)
  newEntryIds: Set<string>;

  // Count deltas (positive or negative adjustments)
  subscriptionCountDeltas: Record<string, number>;
  tagCountDeltas: Record<string, number>;

  // Pending data from SSE
  pendingEntries: PendingEntry[];
  hasNewEntries: boolean;

  // Actions - all idempotent
  markRead: (entryId: string, subscriptionId: string, tagIds?: string[]) => void;
  markUnread: (entryId: string, subscriptionId: string, tagIds?: string[]) => void;
  toggleStar: (entryId: string, currentlyStarred: boolean, subscriptionId?: string) => void;
  onNewEntry: (entryId: string, subscriptionId: string, timestamp: string) => void;
  onEntryUpdated: (entryId: string) => void;
  onSubscriptionCreated: (subscriptionId: string, unreadCount: number, tagIds: string[]) => void;
  onSubscriptionDeleted: (subscriptionId: string, tagIds: string[]) => void;

  // Bulk operations
  markMultipleRead: (entryIds: string[], subscriptionId: string, tagIds?: string[]) => void;

  // Reset operations
  reset: () => void;
  clearPendingEntries: () => void;
}

const initialState = {
  readIds: new Set<string>(),
  unreadIds: new Set<string>(),
  starredIds: new Set<string>(),
  unstarredIds: new Set<string>(),
  newEntryIds: new Set<string>(),
  subscriptionCountDeltas: {},
  tagCountDeltas: {},
  pendingEntries: [],
  hasNewEntries: false,
};

/**
 * Zustand store for tracking real-time deltas with Redux DevTools integration
 */
export const useRealtimeStore = create<RealtimeStore>()(
  devtools(
    (set) => ({
      ...initialState,

      /**
       * Mark an entry as read (idempotent).
       * Decrements the unread count for the subscription and all its tags.
       */
      markRead: (entryId: string, subscriptionId: string, tagIds?: string[]) =>
        set((state) => {
          // Idempotent: skip if already marked read
          if (state.readIds.has(entryId)) {
            if (DEBUG) console.log("⏭️  markRead: already read", { entryId });
            return state;
          }

          if (DEBUG) {
            console.log("📖 markRead:", { entryId, subscriptionId, tagIds });
          }

          // Update tag count deltas (decrement for all tags)
          const newTagCountDeltas = tagIds
            ? tagIds.reduce(
                (acc, tagId) => ({
                  ...acc,
                  [tagId]: (state.tagCountDeltas[tagId] || 0) - 1,
                }),
                { ...state.tagCountDeltas }
              )
            : state.tagCountDeltas;

          // If we previously marked it unread, undo that instead
          if (state.unreadIds.has(entryId)) {
            const newUnreadIds = new Set(state.unreadIds);
            newUnreadIds.delete(entryId);
            return {
              unreadIds: newUnreadIds,
              subscriptionCountDeltas: {
                ...state.subscriptionCountDeltas,
                [subscriptionId]: (state.subscriptionCountDeltas[subscriptionId] || 0) + 1,
              },
              tagCountDeltas: newTagCountDeltas,
            };
          }

          return {
            readIds: new Set([...state.readIds, entryId]),
            subscriptionCountDeltas: {
              ...state.subscriptionCountDeltas,
              [subscriptionId]: (state.subscriptionCountDeltas[subscriptionId] || 0) - 1,
            },
            tagCountDeltas: newTagCountDeltas,
          };
        }),

      /**
       * Mark an entry as unread (idempotent).
       * Increments the unread count for the subscription and all its tags.
       */
      markUnread: (entryId: string, subscriptionId: string, tagIds?: string[]) =>
        set((state) => {
          // Idempotent: skip if already marked unread
          if (state.unreadIds.has(entryId)) {
            if (DEBUG) console.log("⏭️  markUnread: already unread", { entryId });
            return state;
          }

          if (DEBUG) {
            console.log("📕 markUnread:", { entryId, subscriptionId, tagIds });
          }

          // Update tag count deltas (increment for all tags)
          const newTagCountDeltas = tagIds
            ? tagIds.reduce(
                (acc, tagId) => ({
                  ...acc,
                  [tagId]: (state.tagCountDeltas[tagId] || 0) + 1,
                }),
                { ...state.tagCountDeltas }
              )
            : state.tagCountDeltas;

          // If we previously marked it read, undo that instead
          if (state.readIds.has(entryId)) {
            const newReadIds = new Set(state.readIds);
            newReadIds.delete(entryId);
            return {
              readIds: newReadIds,
              subscriptionCountDeltas: {
                ...state.subscriptionCountDeltas,
                [subscriptionId]: (state.subscriptionCountDeltas[subscriptionId] || 0) + 1,
              },
              tagCountDeltas: newTagCountDeltas,
            };
          }

          return {
            unreadIds: new Set([...state.unreadIds, entryId]),
            subscriptionCountDeltas: {
              ...state.subscriptionCountDeltas,
              [subscriptionId]: (state.subscriptionCountDeltas[subscriptionId] || 0) + 1,
            },
            tagCountDeltas: newTagCountDeltas,
          };
        }),

      /**
       * Toggle star status for an entry (idempotent based on current state).
       */
      toggleStar: (entryId: string, currentlyStarred: boolean) =>
        set((state) => {
          if (DEBUG) {
            console.log(currentlyStarred ? "☆ unstar:" : "⭐ star:", { entryId });
          }

          if (currentlyStarred) {
            // Unstarring
            if (state.unstarredIds.has(entryId)) {
              if (DEBUG) console.log("⏭️  toggleStar: already unstarred", { entryId });
              return state; // Already unstarred
            }

            // If we previously starred it, undo that
            if (state.starredIds.has(entryId)) {
              const newStarredIds = new Set(state.starredIds);
              newStarredIds.delete(entryId);
              if (DEBUG) console.log("↩️  toggleStar: undoing previous star", { entryId });
              return { starredIds: newStarredIds };
            }

            return {
              unstarredIds: new Set([...state.unstarredIds, entryId]),
            };
          } else {
            // Starring
            if (state.starredIds.has(entryId)) {
              if (DEBUG) console.log("⏭️  toggleStar: already starred", { entryId });
              return state; // Already starred
            }

            // If we previously unstarred it, undo that
            if (state.unstarredIds.has(entryId)) {
              const newUnstarredIds = new Set(state.unstarredIds);
              newUnstarredIds.delete(entryId);
              if (DEBUG) console.log("↩️  toggleStar: undoing previous unstar", { entryId });
              return { unstarredIds: newUnstarredIds };
            }

            return {
              starredIds: new Set([...state.starredIds, entryId]),
            };
          }
        }),

      /**
       * Handle new entry from SSE (idempotent).
       * Increments the unread count for the subscription.
       */
      onNewEntry: (entryId: string, subscriptionId: string, timestamp: string) =>
        set((state) => {
          // Idempotent: skip if we've already seen this entry
          if (state.newEntryIds.has(entryId)) {
            return state;
          }

          return {
            newEntryIds: new Set([...state.newEntryIds, entryId]),
            pendingEntries: [{ id: entryId, subscriptionId, timestamp }, ...state.pendingEntries],
            subscriptionCountDeltas: {
              ...state.subscriptionCountDeltas,
              [subscriptionId]: (state.subscriptionCountDeltas[subscriptionId] || 0) + 1,
            },
            hasNewEntries: true,
          };
        }),

      /**
       * Handle entry updated from SSE.
       * Currently just tracks that we've seen it (for future use).
       */
      onEntryUpdated: (entryId: string) =>
        set((state) => ({
          newEntryIds: new Set([...state.newEntryIds, entryId]),
        })),

      /**
       * Handle subscription created from SSE (idempotent).
       * Adds the subscription's unread count to tag deltas.
       */
      onSubscriptionCreated: (subscriptionId: string, unreadCount: number, tagIds: string[]) =>
        set((state) => {
          // Update tag count deltas for all tags on this subscription
          const newTagCountDeltas = { ...state.tagCountDeltas };
          for (const tagId of tagIds) {
            newTagCountDeltas[tagId] = (newTagCountDeltas[tagId] || 0) + unreadCount;
          }

          return {
            subscriptionCountDeltas: {
              ...state.subscriptionCountDeltas,
              [subscriptionId]: unreadCount,
            },
            tagCountDeltas: newTagCountDeltas,
          };
        }),

      /**
       * Handle subscription deleted from SSE (idempotent).
       * Removes the subscription's unread count from tag deltas.
       */
      onSubscriptionDeleted: (subscriptionId: string, tagIds: string[]) =>
        set((state) => {
          // Get the current count delta for this subscription
          const subDelta = state.subscriptionCountDeltas[subscriptionId] || 0;

          // Update tag count deltas (subtract the subscription's contribution)
          const newTagCountDeltas = { ...state.tagCountDeltas };
          for (const tagId of tagIds) {
            newTagCountDeltas[tagId] = (newTagCountDeltas[tagId] || 0) - subDelta;
          }

          // Remove the subscription delta
          const newSubDeltas = { ...state.subscriptionCountDeltas };
          delete newSubDeltas[subscriptionId];

          return {
            subscriptionCountDeltas: newSubDeltas,
            tagCountDeltas: newTagCountDeltas,
          };
        }),

      /**
       * Mark multiple entries as read at once.
       * More efficient than calling markRead in a loop.
       */
      markMultipleRead: (entryIds: string[], subscriptionId: string, tagIds?: string[]) =>
        set((state) => {
          let countDelta = 0;
          const newReadIds = new Set(state.readIds);
          const newUnreadIds = new Set(state.unreadIds);

          for (const entryId of entryIds) {
            // Skip if already marked read
            if (state.readIds.has(entryId)) {
              continue;
            }

            // If we previously marked it unread, undo that
            if (state.unreadIds.has(entryId)) {
              newUnreadIds.delete(entryId);
              countDelta += 1;
            } else {
              // Normal case: marking as read
              newReadIds.add(entryId);
              countDelta -= 1;
            }
          }

          // Update tag count deltas
          const newTagCountDeltas = tagIds
            ? tagIds.reduce(
                (acc, tagId) => ({
                  ...acc,
                  [tagId]: (state.tagCountDeltas[tagId] || 0) + countDelta,
                }),
                { ...state.tagCountDeltas }
              )
            : state.tagCountDeltas;

          return {
            readIds: newReadIds,
            unreadIds: newUnreadIds,
            subscriptionCountDeltas: {
              ...state.subscriptionCountDeltas,
              [subscriptionId]: (state.subscriptionCountDeltas[subscriptionId] || 0) + countDelta,
            },
            tagCountDeltas: newTagCountDeltas,
          };
        }),

      /**
       * Reset all deltas to initial state.
       * Used when:
       * - SSE reconnects after long disconnect
       * - Sync gap detected (server truncated history)
       * - User manually triggers refresh
       */
      reset: () => set(initialState),

      /**
       * Clear pending entries (e.g., after user clicks "Show X new entries").
       */
      clearPendingEntries: () =>
        set({
          pendingEntries: [],
          hasNewEntries: false,
        }),
    }),
    { name: "RealtimeStore" }
  )
);
