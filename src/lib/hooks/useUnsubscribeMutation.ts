/**
 * useUnsubscribeMutation Hook
 *
 * Shared `subscriptions.delete` choreography used by every unsubscribe surface
 * (the sidebar feed list and the broken-feeds settings page). Both used to
 * hand-roll the same optimistic-remove / onSuccess-counts / onError-rollback
 * sequence; consolidating it here means a fix to the cache handling (e.g. how
 * absolute counts are applied) can't miss one call site (#1081).
 *
 * The cache side effects are owned by the hook:
 * - onMutate: optimistically remove the subscription from all caches.
 * - onSuccess: apply the server-absolute counts and invalidate entries.list so
 *   the removed feed's entries are re-filtered out.
 * - onError: toast + invalidate subscription/tag/count caches to refetch truth.
 *
 * Callers pass extra callbacks for their own UI concerns (closing a dialog,
 * showing a success toast, invalidating a page-specific list). These run in
 * addition to the shared cache work, not instead of it.
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import {
  forgetDeletedSubscription,
  removeSubscriptionFromCaches,
  setEntryRelatedCounts,
} from "@/lib/cache/operations";
import { getLocalDb } from "@/lib/local-db/local-db";
import { writeLiveSubscriptions } from "@/lib/local-db/subscriptions";

export interface UseUnsubscribeMutationOptions {
  /** Extra work after the optimistic cache removal (e.g. close a dialog). */
  onMutate?: () => void;
  /** Extra work after counts are applied (e.g. toast, page-specific refetch). */
  onSuccess?: () => void;
  /** Extra work after the rollback invalidations (e.g. clear local state). */
  onError?: () => void;
}

export function useUnsubscribeMutation(options?: UseUnsubscribeMutationOptions) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  return trpc.subscriptions.delete.useMutation({
    onMutate: (variables) => {
      // Optimistically remove the subscription from the sidebar/lists. Counts
      // are applied from the server response in onSuccess.
      const removed = getLocalDb(queryClient).subscriptions.rows.getSynced(variables.id);
      removeSubscriptionFromCaches(variables.id, queryClient);
      options?.onMutate?.();
      return { removed };
    },
    onSuccess: (data, variables) => {
      // Apply the server-absolute counts for the affected lists, and drop the
      // subscription's entries from any cached lists.
      if (data.counts) {
        setEntryRelatedCounts(utils, data.counts, queryClient);
      }
      utils.entries.list.invalidate();
      forgetDeletedSubscription(utils, variables.id);
      options?.onSuccess?.();
    },
    onError: (_error, _variables, context) => {
      toast.error("Failed to unsubscribe from feed");
      // Put the row back (an unread-only refetch wouldn't return a read one),
      // then refetch to correct anything else.
      if (context?.removed) {
        writeLiveSubscriptions(getLocalDb(queryClient).subscriptions, [context.removed]);
      }
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      utils.entries.count.invalidate();
      options?.onError?.();
    },
  });
}
