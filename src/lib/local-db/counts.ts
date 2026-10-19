/**
 * Unread counts for every list but a subscription (whose count is on its row,
 * `subscriptions.ts`): All, Starred, Saved, each tag and Uncategorized. They
 * come from `entries.countLists` and `tags.list` results and from the counts that
 * mutation responses and events carry, each stamped with when the server read
 * it (`countsAsOfSchema`). The newest stamp wins, so a response or event that
 * arrives after a newer one can't overwrite it.
 */

import { isCountsAsOfNewer } from "@/lib/events/schemas";
import type { SyncedCollection } from "./synced-collection";

export interface CountRow {
  /** The list (`countKey`). */
  key: string;
  unread: number;
}

export interface CountStore {
  rows: SyncedCollection<CountRow>;
  /** The stamp of each stored count. */
  asOf: Map<string, string>;
}

/** The lists with a count of their own. */
export type CountedList =
  { all: true } | { starred: true } | { saved: true } | { uncategorized: true } | { tagId: string };

export function countKey(list: CountedList): string {
  if ("tagId" in list) return `tag:${list.tagId}`;
  if ("starred" in list) return "starred";
  if ("saved" in list) return "saved";
  if ("uncategorized" in list) return "uncategorized";
  return "all";
}

/** Stores counts read at `asOf`, except over newer ones. */
export function writeCounts(
  store: CountStore,
  counts: Array<{ list: CountedList; unread: number }>,
  asOf: string
): void {
  const rows: CountRow[] = [];
  for (const { list, unread } of counts) {
    const key = countKey(list);
    if (!isCountsAsOfNewer(asOf, store.asOf.get(key))) continue;
    store.asOf.set(key, asOf);
    if (store.rows.getSynced(key)?.unread !== unread) rows.push({ key, unread });
  }
  store.rows.upsert(rows);
}

/** Drops a deleted tag's count. */
export function removeTagCount(store: CountStore, tagId: string): void {
  const key = countKey({ tagId });
  store.asOf.delete(key);
  store.rows.remove([key]);
}
