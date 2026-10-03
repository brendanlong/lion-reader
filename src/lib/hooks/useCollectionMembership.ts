/**
 * useCollectionMembership Hook
 *
 * An entry's collection membership and the mutations that change it, for the
 * "Add to collection" picker. Membership lives in `collections.listForEntry`;
 * responses are applied through `applyCollectionEntriesChange`, the same
 * operation the SSE event runs, so the two can land in either order.
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { applyCollectionEntriesChange, handleSubscriptionCreated } from "@/lib/cache/operations";

export function useCollectionMembership(entryId: string) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const membership = trpc.collections.listForEntry.useQuery({ entryId });

  const onError = () => toast.error("Failed to update collection");

  const addMutation = trpc.collections.addEntries.useMutation({
    onSuccess: (result, variables) =>
      applyCollectionEntriesChange(utils, queryClient, {
        subscriptionId: variables.id,
        entryIds: result.entryIds,
        added: true,
        counts: result.counts,
      }),
    onError,
  });
  const removeMutation = trpc.collections.removeEntries.useMutation({
    onSuccess: (result, variables) =>
      applyCollectionEntriesChange(utils, queryClient, {
        subscriptionId: variables.id,
        entryIds: result.entryIds,
        added: false,
        counts: result.counts,
      }),
    onError,
  });
  const createMutation = trpc.collections.create.useMutation();

  const setMember = (collectionId: string, member: boolean) => {
    const mutation = member ? addMutation : removeMutation;
    mutation.mutate({ id: collectionId, entryIds: [entryId] });
  };

  /** Creates a collection and adds the entry to it. */
  const createWithEntry = async (name: string) => {
    try {
      const { subscription, counts } = await createMutation.mutateAsync({ name });
      handleSubscriptionCreated(utils, subscription, queryClient, counts);
      setMember(subscription.id, true);
    } catch {
      toast.error("Failed to create collection");
    }
  };

  return {
    collectionIds: membership.data?.collectionIds,
    setMember,
    createWithEntry,
    isCreating: createMutation.isPending,
    isUpdating: addMutation.isPending || removeMutation.isPending || createMutation.isPending,
  };
}
