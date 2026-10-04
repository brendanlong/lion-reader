/**
 * Hooks that render subscriptions from the local store
 * (`src/lib/local-db/subscriptions.ts`).
 */

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useLiveQuery } from "@tanstack/react-db";
import { eq } from "@tanstack/db";
import { getLocalDb } from "@/lib/local-db/local-db";
import type { SubscriptionRow } from "@/lib/local-db/subscriptions";

/** Every stored subscription. */
export function useLocalSubscriptions(): SubscriptionRow[] {
  const db = getLocalDb(useQueryClient());
  const { data } = useLiveQuery({
    query: (q) => q.from({ subscription: db.subscriptions.rows.collection }),
  });
  return data;
}

/** One stored subscription, or undefined when the store doesn't hold it. */
export function useLocalSubscription(id: string | undefined): SubscriptionRow | undefined {
  const db = getLocalDb(useQueryClient());
  const { data } = useLiveQuery({
    query: (q) =>
      id === undefined
        ? undefined
        : q
            .from({ subscription: db.subscriptions.rows.collection })
            .where(({ subscription }) => eq(subscription.id, id))
            .findOne(),
  });
  return data;
}
