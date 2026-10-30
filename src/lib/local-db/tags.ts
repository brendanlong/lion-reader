/**
 * The user's tags, from `tags.list` results and tag events. Their unread counts
 * live with every other list's (`counts.ts`); `feedCount` comes only from
 * `tags.list`, which is refetched when it may have changed.
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  fetchVersion,
  isFetchedRowFresh,
  removeLiveRows,
  storeFetchedRows,
  writeLiveRows,
  type VersionedStore,
} from "./versioned-store";

type TagsListData = NonNullable<ReturnType<TRPCClientUtils["tags"]["list"]["getData"]>>;

export type TagRow = Omit<TagsListData["items"][number], "unreadCount">;

export type TagStore = VersionedStore<TagRow>;

/**
 * Stores a `tags.list` result: every tag the user has, so stored tags it
 * lacks were deleted, unless written since the fetch started. Returns the ids
 * it dropped.
 */
export function ingestFetchedTags(
  store: TagStore,
  queryHash: string,
  data: TagsListData
): string[] {
  const version = fetchVersion(store, queryHash);
  const fetchedIds = new Set(data.items.map((tag) => tag.id));
  const gone = store.rows
    .allSynced()
    .filter((tag) => !fetchedIds.has(tag.id) && isFetchedRowFresh(store, tag.id, version))
    .map((tag) => tag.id);
  for (const id of gone) store.versions.set(id, version);
  store.rows.remove(gone);
  storeFetchedRows(
    store,
    version,
    data.items.map(({ unreadCount, ...tag }) => tag)
  );
  return gone;
}

/** Writes a created or updated tag from an event; a new one has no subscriptions yet. */
export function writeLiveTag(
  store: TagStore,
  tag: Pick<TagRow, "id" | "name" | "color"> & Partial<TagRow>
): void {
  const stored = store.rows.getSynced(tag.id);
  writeLiveRows(store, [{ feedCount: 0, createdAt: new Date(), ...stored, ...tag }]);
}

export function removeLiveTag(store: TagStore, id: string): void {
  removeLiveRows(store, [id]);
}
