/**
 * Subscription rows: one per subscription the client has loaded, from
 * `subscriptions.list` pages, `subscriptions.get`, subscription events,
 * mutation responses, and counts naming a subscription it lacks. The sidebar
 * renders its sections from these rows (`sidebarSectionRows`), so a row's
 * count, title or tags changing moves it in or out of a section with no list
 * refetch.
 *
 * Every write is versioned by a local clock: a live write (event, mutation
 * response, counts) by when it happened, a fetched row by when its fetch
 * started. A fetched row is stored only over an older version, so a fetch that
 * started before a newer write (or a removal) can't undo it when it lands.
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
  /** The version of each subscription's stored row, kept after it's removed. */
  versions: Map<string, number>;
  /** By query hash: when its latest fetch started. */
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
  for (const row of rows) store.versions.set(row.id, now);
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

/** Returns the removal's version, for `restoreRemovedSubscription`. */
export function removeLiveSubscriptions(store: SubscriptionStore, ids: string[]): number {
  const now = tick(store);
  for (const id of ids) store.versions.set(id, now);
  store.rows.remove(ids);
  return now;
}

/**
 * Undoes an optimistic removal, unless something has written the row since
 * (say, its `subscription_deleted` event arrived before the mutation failed).
 */
export function restoreRemovedSubscription(
  store: SubscriptionStore,
  row: SubscriptionRow,
  removedAt: number
): void {
  if (store.versions.get(row.id) === removedAt) writeLiveSubscriptions(store, [row]);
}

export function markSubscriptionFetchStarted(store: SubscriptionStore, queryHash: string): void {
  store.fetchStartedAt.set(queryHash, tick(store));
}

const NEVER = -1;

/** Stores rows a query fetched, except over a newer version. */
export function ingestFetchedSubscriptions(
  store: SubscriptionStore,
  queryHash: string,
  rows: SubscriptionRow[]
): void {
  const version = store.fetchStartedAt.get(queryHash) ?? 0;
  const fresh = rows.filter((row) => (store.versions.get(row.id) ?? NEVER) < version);
  for (const row of fresh) store.versions.set(row.id, version);
  store.rows.upsert(fresh);
}

/**
 * The sidebar section a `subscriptions.list` input fetches, when it's one:
 * the tag's (or Uncategorized's) subscriptions, unfiltered by search or type.
 */
export function sidebarSectionOf(input: SubscriptionListInput): string | undefined {
  if (input.query || input.type) return undefined;
  return input.uncategorized ? UNCATEGORIZED_SECTION : input.tagId;
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
