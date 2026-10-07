"use client";

import { useSyncExternalStore } from "react";
import { createStoredBoolean } from "@/lib/stored-boolean";

type StoredBoolean = ReturnType<typeof createStoredBoolean>;

const stores = new Map<string, StoredBoolean>();

function storeFor(key: string): StoredBoolean {
  let store = stores.get(key);
  if (!store) {
    store = createStoredBoolean(`lion-reader:show-original:${key}`, false);
    stores.set(key, store);
  }
  return store;
}

const noopSubscribe = () => () => {};

/** Stands in while the entry is loading: false, and the setter is a no-op. */
const loading: StoredBoolean = {
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
 * Whether to show the original (vs cleaned) content, remembered in
 * localStorage per `key` (see `showOriginalKey`).
 */
export function useShowOriginalPreference(
  key: string | undefined
): [boolean, (value: boolean) => void] {
  const store = key ? storeFor(key) : loading;
  return [store.useValue(), store.set];
}

/**
 * Per feed subscription; saved articles (whose subscription is the saved one)
 * and any entry without a subscription share one per type.
 */
export function showOriginalKey(entry: { subscriptionId: string | null; type: string }): string {
  return entry.type === "saved" ? entry.type : (entry.subscriptionId ?? entry.type);
}
