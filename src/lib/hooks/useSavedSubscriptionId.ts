"use client";

import { useCallback, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "@/lib/trpc/client";
import { SAVED_SUBSCRIPTION_LIST_INPUT } from "@/lib/queries/saved-subscription";
import { getLocalDb, subscribeSavedSubscriptionId } from "@/lib/local-db/local-db";

/**
 * The user's saved subscription id as the store knows it (`LocalDb.saved`),
 * loading it (`SAVED_SUBSCRIPTION_LIST_INPUT`) if nothing has: null before
 * their first save, undefined while loading.
 */
export function useSavedSubscriptionId(): string | null | undefined {
  trpc.subscriptions.list.useQuery(SAVED_SUBSCRIPTION_LIST_INPUT, { staleTime: Infinity });
  const db = getLocalDb(useQueryClient());
  const subscribe = useCallback(
    (listener: () => void) => subscribeSavedSubscriptionId(db, listener),
    [db]
  );
  const read = () => db.saved.id;
  return useSyncExternalStore(subscribe, read, read);
}
