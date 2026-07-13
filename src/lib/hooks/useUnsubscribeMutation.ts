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
import { removeSubscriptionFromCaches, setEntryRelatedCounts } from "@/lib/cache/operations";

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
      removeSubscriptionFromCaches(variables.id, queryClient);
      options?.onMutate?.();
    },
    onSuccess: (data) => {
      // Apply the server-absolute counts for the affected lists, and drop the
      // subscription's entries from any cached lists.
      if (data.counts) {
        setEntryRelatedCounts(utils, data.counts, queryClient);
      }
      utils.entries.list.invalidate();
      options?.onSuccess?.();
    },
    onError: () => {
      toast.error("Failed to unsubscribe from feed");
      // On error, invalidate to refetch correct state.
      utils.subscriptions.list.invalidate();
      utils.tags.list.invalidate();
      utils.entries.count.invalidate();
      options?.onError?.();
    },
  });
}
