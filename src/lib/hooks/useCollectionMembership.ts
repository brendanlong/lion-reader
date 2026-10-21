/**
 * useCollectionMembership Hook
 *
 * An entry's collection membership and the mutations that change it, for the
 * "Add to collection" picker. Membership is the stored entry's
 * `subscriptionIds`; responses are applied through
 * `applyCollectionEntriesChange`, the same operation the SSE event runs, so
 * the two can land in either order.
 */

"use client";

import { useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { applyCollectionEntriesChange, handleSubscriptionCreated } from "@/lib/cache/operations";
import { useLocalEntry } from "@/lib/hooks/useLocalEntries";
import { useSavedSubscriptionId } from "@/lib/hooks/useSavedSubscriptionId";
import { useLocalSubscriptions } from "@/lib/hooks/useLocalSubscriptions";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";
import type { EntryRow } from "@/lib/local-db/entries";

/**
 * The collections holding an entry: every membership but its origin, the saved
 * subscription and any other stored subscription that isn't a collection (an
 * article can be in two feeds' subscriptions after a redirect merge).
 */
function collectionIdsOf(
  entry: EntryRow,
  savedSubscriptionId: string | null,
  typeOf: (subscriptionId: string) => string | undefined
): string[] {
  return entry.subscriptionIds.filter(
    (id) =>
      id !== entry.subscriptionId &&
      id !== savedSubscriptionId &&
      (typeOf(id) ?? "collection") === "collection"
  );
}

export function useCollectionMembership(entryId: string) {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();
  const entry = useLocalEntry(entryId);
  const savedSubscriptionId = useSavedSubscriptionId();
  const subscriptions = useLocalSubscriptions();
  const collectionIds = useMemo(() => {
    if (!entry || savedSubscriptionId === undefined) return undefined;
    const types = new Map(subscriptions.map((row) => [row.id, row.type]));
    return collectionIdsOf(entry, savedSubscriptionId, (id) => types.get(id));
  }, [entry, savedSubscriptionId, subscriptions]);
  const savedLookupFailed = trpc.subscriptions.list.useQuery(SAVED_SUBSCRIPTION_LIST_INPUT, {
    staleTime: Infinity,
  }).isError;

  const onError = () => toast.error("Failed to update collection");

  const addMutation = trpc.collections.addEntries.useMutation({
    onSuccess: (result, variables) =>
      applyCollectionEntriesChange(utils, queryClient, {
        subscriptionId: variables.id,
        entryIds: result.entryIds,
        added: true,
        counts: result.counts,
        tagLists: result.tagLists,
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
        tagLists: result.tagLists,
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
   * count. When the user already has a collection with that name (ignoring
   * case), the entry is added to it instead. Returns the collection, or null
   * if creating failed.
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
    if (!created.created) {
      // Already listed in the sidebar; adding updates its count. A failure
      // is reported by the mutation's onError.
      await addMutation
        .mutateAsync({ id: subscription.id, entryIds: [entryId] })
        .catch(() => undefined);
      return subscription;
    }
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
    /** Undefined until the entry and the saved subscription's id are known. */
    collectionIds,
    /** The saved subscription's id couldn't be looked up, so `collectionIds` won't load. */
    membershipFailed: savedLookupFailed,
    setMember,
    createWithEntry,
    isCreating: createMutation.isPending,
    isUpdating: addMutation.isPending || removeMutation.isPending || createMutation.isPending,
  };
}
