/**
 * useEntryMutations Hook
 *
 * Entry mutations (markRead, star/unstar, markAllRead). Read/starred changes
 * are TanStack DB transactions on the local entry store: the intended state
 * shows immediately as an optimistic overlay, the server response is written
 * to the synced layer (newest `updatedAt` wins), and when the transaction
 * settles the overlay drops — leaving the newest server state, or on failure
 * the state the server last reported. See "Optimistic Updates" in
 * src/FRONTEND_STATE.md. Counts always come from the response.
 */

"use client";

import { useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createTransaction } from "@tanstack/db";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { handleMarkAllRead, setBulkCounts } from "@/lib/cache/operations";
import { setServerEntryState, type EntryRow } from "@/lib/local-db/entries";
import { getLocalDb, insertEntryIntoLists, type LocalDb } from "@/lib/local-db/local-db";

/**
 * Sends a mutation with `applyOptimistic` layered over the entries the store
 * holds until `send` (which writes the response to the synced layer)
 * settles.
 *
 * A transaction that records no changes completes without calling its
 * mutation function, and TanStack DB records none for entries the store
 * doesn't hold or for a re-assert of the current state (e.g. marking an
 * already-read entry read, which still has to reach the server to move its
 * `readChangedAt`). Then there is nothing to show optimistically, so the
 * mutation is just sent.
 */
function mutateEntries(
  db: LocalDb,
  entryIds: string[],
  applyOptimistic: (draft: EntryRow) => void,
  send: () => Promise<unknown>
): Promise<unknown> {
  const held = entryIds.filter((id) => db.entries.collection.has(id));
  const transaction = createTransaction({ autoCommit: false, mutationFn: send });
  if (held.length > 0) {
    transaction.mutate(() => {
      db.entries.collection.update(held, (drafts) => drafts.forEach(applyOptimistic));
    });
  }
  if (transaction.mutations.length === 0) {
    // Completes at once without calling `send`; this just releases it.
    void transaction.commit();
    return send();
  }
  return transaction.commit();
}

/**
 * Entry type for routing.
 */
export type EntryType = "web" | "email" | "saved";

/**
 * Options for the markAllRead mutation.
 */
export interface MarkAllReadOptions {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  starredOnly?: boolean;
  type?: EntryType;
}

/**
 * Result of the useEntryMutations hook.
 */
export interface UseEntryMutationsResult {
  /**
   * Mark one or more entries as read or unread.
   */
  markRead: (ids: string[], read: boolean) => void;

  /**
   * Toggle the read status of an entry.
   */
  toggleRead: (entryId: string, currentlyRead: boolean) => void;

  /**
   * Mark all entries as read with optional filters.
   */
  markAllRead: (options?: MarkAllReadOptions) => void;

  /**
   * Star an entry.
   */
  star: (entryId: string) => void;

  /**
   * Unstar an entry.
   */
  unstar: (entryId: string) => void;

  /**
   * Toggle the starred status of an entry.
   */
  toggleStar: (entryId: string, currentlyStarred: boolean) => void;

  /**
   * Whether the markAllRead mutation is pending.
   */
  isMarkAllReadPending: boolean;
}

/**
 * Hook that provides entry mutations with direct cache updates.
 *
 * @example
 * ```tsx
 * function EntryList() {
 *   const { toggleRead, toggleStar } = useEntryMutations();
 *
 *   return (
 *     <Entry
 *       onToggleRead={(id, read) => toggleRead(id, read)}
 *       onToggleStar={(id, starred) => toggleStar(id, starred)}
 *     />
 *   );
 * }
 * ```
 */
export function useEntryMutations(): UseEntryMutationsResult {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const db = getLocalDb(queryClient);
  // The requests go through React Query mutations (not the vanilla client) so
  // failures reach the MutationCache, where AuthErrorHandler watches for an
  // expired session.
  const { mutateAsync: sendMarkRead } = trpc.entries.markRead.useMutation();
  const { mutateAsync: sendSetStarred } = trpc.entries.setStarred.useMutation();

  const markRead = useCallback(
    (ids: string[], read: boolean) => {
      const changedAt = new Date();
      if (!read) {
        // An entry becoming unread belongs in unread-only lists fetched while
        // it was read (e.g. mark-unread in "Show All", then toggle back to
        // "Unread only" — the toggle switches lists without a refetch).
        for (const id of ids) {
          const entry = db.entries.collection.get(id);
          if (entry) insertEntryIntoLists(db, queryClient, { ...entry, read: false });
        }
      }
      mutateEntries(
        db,
        ids,
        (draft) => {
          draft.read = read;
        },
        async () => {
          const data = await sendMarkRead({
            entries: ids.map((id) => ({ id, changedAt })),
            read,
          });
          for (const entry of data.entries) setServerEntryState(db.entries, entry.id, entry);
          if (data.counts) setBulkCounts(utils, data.counts, queryClient);
        }
      ).catch((error: unknown) => {
        console.error("markRead mutation error:", error);
        toast.error("Failed to update read status");
      });
    },
    [db, queryClient, utils, sendMarkRead]
  );

  const setStarred = useCallback(
    (entryId: string, starred: boolean) => {
      const changedAt = new Date();
      mutateEntries(
        db,
        [entryId],
        (draft) => {
          draft.starred = starred;
        },
        async () => {
          const data = await sendSetStarred({
            id: entryId,
            starred,
            changedAt,
          });
          setServerEntryState(db.entries, data.entry.id, data.entry);
          // Array check: a server from the previous release (canary/rollback
          // window) returns the single-subscription counts shape, which lacks
          // `subscriptions`; skip it and let the entry_state_changed event,
          // which always carries the bulk shape, set the counts.
          if (data.counts && Array.isArray(data.counts.subscriptions)) {
            setBulkCounts(utils, data.counts, queryClient);
          }
        }
      ).catch((error: unknown) => {
        console.error("setStarred mutation error:", error);
        toast.error(starred ? "Failed to star entry" : "Failed to unstar entry");
      });
    },
    [db, queryClient, utils, sendSetStarred]
  );

  const markAllReadMutation = trpc.entries.markAllRead.useMutation({
    onSuccess: (data) => {
      // Nothing marked means no counts changed, but the list may still show
      // entries read elsewhere.
      if (data.count > 0) handleMarkAllRead(utils, queryClient, data.counts);
      else utils.entries.list.invalidate();
    },
    onError: () => {
      toast.error("Failed to mark all as read");
    },
  });

  const toggleRead = useCallback(
    (entryId: string, currentlyRead: boolean) => markRead([entryId], !currentlyRead),
    [markRead]
  );

  const markAllRead = useCallback(
    (options?: MarkAllReadOptions) => {
      markAllReadMutation.mutate({ ...options, changedAt: new Date() });
    },
    [markAllReadMutation]
  );

  const star = useCallback((entryId: string) => setStarred(entryId, true), [setStarred]);
  const unstar = useCallback((entryId: string) => setStarred(entryId, false), [setStarred]);
  const toggleStar = useCallback(
    (entryId: string, currentlyStarred: boolean) => setStarred(entryId, !currentlyStarred),
    [setStarred]
  );

  return useMemo(
    () => ({
      markRead,
      toggleRead,
      markAllRead,
      star,
      unstar,
      toggleStar,
      isMarkAllReadPending: markAllReadMutation.isPending,
    }),
    [markRead, toggleRead, markAllRead, star, unstar, toggleStar, markAllReadMutation.isPending]
  );
}
