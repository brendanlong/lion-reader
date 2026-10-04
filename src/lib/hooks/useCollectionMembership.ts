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

  /**
   * Creates a collection and adds the entry to it. The sidebar learns of the
   * collection only once the entry is in it, so it shows the collection's
   * count. Returns the collection, or null if creating failed.
   */
  const createWithEntry = async (name: string) => {
    let created;
    try {
      created = await createMutation.mutateAsync({ name });
    } catch {
      toast.error("Failed to create collection");
      return null;
    }
    const { subscription } = created;
    try {
      const result = await addMutation.mutateAsync({ id: subscription.id, entryIds: [entryId] });
      handleSubscriptionCreated(
        utils,
        {
          ...subscription,
          unreadCount:
            result.counts?.subscriptions.find((s) => s.id === subscription.id)?.unread ?? 0,
        },
        queryClient,
        result.counts ?? created.counts
      );
    } catch {
      handleSubscriptionCreated(utils, subscription, queryClient, created.counts);
    }
    return subscription;
  };

  return {
    collectionIds: membership.data?.collectionIds,
    membershipStatus: membership.status,
    setMember,
    createWithEntry,
    isCreating: createMutation.isPending,
    isUpdating: addMutation.isPending || removeMutation.isPending || createMutation.isPending,
  };
}
