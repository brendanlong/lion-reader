/**
 * Subscription rows: one per subscription the client has loaded, from
 * `subscriptions.list` pages, `subscriptions.get`, subscription events,
 * mutation responses, and counts naming a subscription it lacks. The sidebar
 * renders its sections from these rows (`sidebarSectionRows`), so a row's
 * count, title or tags changing moves it in or out of a section with no list
 * refetch.
 *
 * Live writes (events, mutation responses, counts) are stamped from a local
 * clock, and a fetch that started before a row's last live write leaves that
 * row alone when it lands: its server snapshot is older.
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";
import {
  UNCATEGORIZED_SECTION,
  compareSidebarOrder,
  isInSidebarSection,
} from "@/lib/sidebar-sections";
import type { SyncedCollection } from "./synced-collection";

/** A subscription as `subscriptions.list` / `subscriptions.get` return it. */
export type SubscriptionRow = NonNullable<
  ReturnType<TRPCClientUtils["subscriptions"]["list"]["getData"]>
>["items"][number];

export interface SubscriptionStore {
  rows: SyncedCollection<SubscriptionRow>;
  /** Clock reading of each subscription's last live write or removal. */
  liveWriteAt: Map<string, number>;
  /** Clock reading when each query's latest fetch started, by query hash. */
  fetchStartedAt: Map<string, number>;
  clock: { now: number };
}

/** A `subscriptions.list` input, as the sidebar sections pass it. */
export interface SubscriptionListInput {
  tagId?: string;
  uncategorized?: boolean;
  unreadOnly?: boolean;
  query?: string;
  type?: string;
}

export interface SubscriptionPages {
  pages: Array<{ items: SubscriptionRow[]; nextCursor?: string }>;
}

function tick(store: SubscriptionStore): number {
  return ++store.clock.now;
}

/** Writes rows from an event or mutation response. */
export function writeLiveSubscriptions(store: SubscriptionStore, rows: SubscriptionRow[]): void {
  const now = tick(store);
  for (const row of rows) store.liveWriteAt.set(row.id, now);
  store.rows.upsert(rows);
}

/** Patches a stored subscription from an event; a no-op when it isn't stored. */
export function patchLiveSubscription(
  store: SubscriptionStore,
  id: string,
  patch: Partial<SubscriptionRow>
): void {
  const row = store.rows.getSynced(id);
  if (row) writeLiveSubscriptions(store, [{ ...row, ...patch }]);
}

export function removeLiveSubscriptions(store: SubscriptionStore, ids: string[]): void {
  const now = tick(store);
  for (const id of ids) store.liveWriteAt.set(id, now);
  store.rows.remove(ids);
}

export function markSubscriptionFetchStarted(store: SubscriptionStore, queryHash: string): void {
  store.fetchStartedAt.set(queryHash, tick(store));
}

function writtenSinceFetch(store: SubscriptionStore, id: string, queryHash: string): boolean {
  return (store.liveWriteAt.get(id) ?? 0) > (store.fetchStartedAt.get(queryHash) ?? 0);
}

/** Stores fetched rows, except those written live since the fetch started. */
export function ingestFetchedSubscriptions(
  store: SubscriptionStore,
  queryHash: string,
  rows: SubscriptionRow[]
): void {
  store.rows.upsert(rows.filter((row) => !writtenSinceFetch(store, row.id, queryHash)));
}

/**
 * The sidebar section a `subscriptions.list` input fetches, when it's one:
 * the tag's (or Uncategorized's) subscriptions, unfiltered by search or type.
 */
export function sidebarSectionOf(input: SubscriptionListInput): string | undefined {
  if (input.query || input.type) return undefined;
  return input.uncategorized ? UNCATEGORIZED_SECTION : input.tagId;
}

/**
 * Corrects stored counts after a complete refetch of an unread-only section:
 * a stored row it should have returned but didn't has no unread entries now
 * (a change this client wasn't told about, such as mark-all-read). Only for
 * full refetches, which read every loaded page after the fetch started.
 */
export function settleUnreadOnlySection(
  store: SubscriptionStore,
  queryHash: string,
  section: string,
  data: SubscriptionPages
): void {
  const window = loadedWindow(data);
  const stale = store.rows
    .allSynced()
    .filter(
      (row) =>
        row.unreadCount > 0 &&
        !window.rank.has(row.id) &&
        isInSidebarSection(row, section) &&
        isInWindow(window, row) &&
        !writtenSinceFetch(store, row.id, queryHash)
    );
  store.rows.upsert(stale.map((row) => ({ ...row, unreadCount: 0 })));
}

interface LoadedWindow {
  /** Server position of each loaded row. */
  rank: Map<string, number>;
  /** The last loaded row while more pages exist; rows sorting after it aren't loaded. */
  edge: SubscriptionRow | undefined;
}

function loadedWindow(data: SubscriptionPages): LoadedWindow {
  const items = data.pages.flatMap((page) => page.items);
  const hasMore = data.pages.at(-1)?.nextCursor !== undefined;
  return {
    rank: new Map(items.map((item, index) => [item.id, index])),
    edge: hasMore ? items.at(-1) : undefined,
  };
}

function isInWindow(window: LoadedWindow, row: SubscriptionRow): boolean {
  return !window.edge || window.rank.has(row.id) || compareSidebarOrder(row, window.edge) < 0;
}

/**
 * A sidebar section's rows: the stored subscriptions in `section` (with
 * unread entries, when `unreadOnly`, plus the open one), limited to what the
 * section's loaded pages cover. Loaded rows keep the server's order (its
 * collation decides it); others go where their title sorts among them.
 */
export function sidebarSectionRows(
  rows: SubscriptionRow[],
  options: {
    section: string;
    unreadOnly: boolean;
    data: SubscriptionPages;
    openSubscriptionId: string | undefined;
  }
): SubscriptionRow[] {
  const { section, unreadOnly, data, openSubscriptionId } = options;
  const window = loadedWindow(data);
  const shown = rows.filter(
    (row) =>
      isInSidebarSection(row, section) &&
      (!unreadOnly || row.unreadCount > 0 || row.id === openSubscriptionId) &&
      isInWindow(window, row)
  );
  const result = shown
    .filter((row) => window.rank.has(row.id))
    .sort((a, b) => (window.rank.get(a.id) ?? 0) - (window.rank.get(b.id) ?? 0));
  for (const row of shown.filter((r) => !window.rank.has(r.id)).sort(compareSidebarOrder)) {
    const index = result.findIndex((other) => compareSidebarOrder(other, row) > 0);
    result.splice(index === -1 ? result.length : index, 0, row);
  }
  return result;
}
