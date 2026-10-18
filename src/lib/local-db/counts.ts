/**
 * Unread counts for every list but a subscription (whose count is on its row,
 * `subscriptions.ts`): All, Starred, Saved, each tag and Uncategorized. They
 * come from `entries.count` and `tags.list` results and from the counts that
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

/** The lists with a count of their own, as `entries.count` inputs name them. */
export type CountedList =
  { all: true } | { starred: true } | { saved: true } | { uncategorized: true } | { tagId: string };

export function countKey(list: CountedList): string {
  if ("tagId" in list) return `tag:${list.tagId}`;
  if ("starred" in list) return "starred";
  if ("saved" in list) return "saved";
  if ("uncategorized" in list) return "uncategorized";
  return "all";
}

/** The list an `entries.count` input counts, unless it's a subscription's (or unrecognized). */
export function countedListOf(input: Record<string, unknown>): CountedList | undefined {
  const keys = Object.keys(input).filter((key) => input[key] !== undefined);
  if (keys.length === 0) return { all: true };
  if (keys.length > 1) return undefined;
  if (input.starredOnly === true) return { starred: true };
  if (input.type === "saved") return { saved: true };
  if (input.uncategorized === true) return { uncategorized: true };
  if (typeof input.tagId === "string") return { tagId: input.tagId };
  return undefined;
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
