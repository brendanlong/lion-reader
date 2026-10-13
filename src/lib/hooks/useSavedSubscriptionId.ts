"use client";

import { trpc } from "@/lib/trpc/client";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";

/**
 * The user's saved subscription id (`SAVED_SUBSCRIPTION_LIST_INPUT`): null
 * before their first save, undefined while loading.
 */
export function useSavedSubscriptionId(): string | null | undefined {
  const { data } = trpc.subscriptions.list.useQuery(SAVED_SUBSCRIPTION_LIST_INPUT, {
    staleTime: Infinity,
    select: (result) => result.items[0]?.id ?? null,
  });
  return data;
}
