"use client";

import { useSyncExternalStore } from "react";
import { createStoredBoolean } from "@/lib/stored-boolean";

type StoredBoolean = ReturnType<typeof createStoredBoolean>;

const stores = new Map<string, StoredBoolean>();

function storeFor(feedId: string): StoredBoolean {
  let store = stores.get(feedId);
  if (!store) {
    store = createStoredBoolean(`lion-reader:show-original:${feedId}`, false);
    stores.set(feedId, store);
  }
  return store;
}

const noopSubscribe = () => () => {};

/** Stands in while the entry (and so its feed) is loading: false, and the setter is a no-op. */
const noFeed: StoredBoolean = {
  get: () => false,
  set: () => {},
  useValue: () =>
    useSyncExternalStore(
      noopSubscribe,
      () => false,
      () => false
    ),
};

/**
 * Whether to show the original (vs cleaned) content, remembered per feed in
 * localStorage.
 */
export function useShowOriginalPreference(
  feedId: string | undefined
): [boolean, (value: boolean) => void] {
  const store = feedId ? storeFor(feedId) : noFeed;
  return [store.useValue(), store.set];
}
