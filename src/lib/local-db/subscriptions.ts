/**
 * Subscription rows: one per subscription the client has loaded, from
 * `subscriptions.list` pages, `subscriptions.get`, subscription events,
 * mutation responses, and counts naming a subscription it lacks. The sidebar
 * renders its sections from these rows (`sidebarSectionRows`), so a row's
 * count, title or tags changing moves it in or out of a section with no list
 * refetch.
 *
 * Rows are versioned (`versioned-store.ts`), except for `unreadCount`, which is
 * ordered by its server stamp like every other count (`counts.ts`): a count
 * changes far more often than the rest of the row, and a count-only write
 * mustn't make a fetch in flight drop the row's other fields.
 */

import type { TRPCClientUtils } from "@/lib/trpc/client";
import { isCountsAsOfNewer } from "@/lib/events/schemas";
import {
  UNCATEGORIZED_SECTION,
  compareSidebarOrder,
  isInSidebarSection,
} from "@/lib/sidebar-sections";
import {
  fetchVersion,
  isFetchedRowFresh,
  writeLiveRows,
  type VersionedStore,
} from "./versioned-store";

/** A subscription as `subscriptions.list` / `subscriptions.get` return it. */
export type FetchedSubscriptionRow = NonNullable<
  ReturnType<TRPCClientUtils["subscriptions"]["list"]["getData"]>
>["items"][number];

/** A stored subscription: its count's stamp is kept in `SubscriptionStore.countAsOf`. */
export type SubscriptionRow = Omit<FetchedSubscriptionRow, "unreadCountAsOf">;

export interface SubscriptionStore extends VersionedStore<SubscriptionRow> {
  /** The stamp of each stored `unreadCount` (`countsAsOfSchema`). */
  countAsOf: Map<string, string>;
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
  pages: Array<{
    items: FetchedSubscriptionRow[];
    nextCursor?: string;
    savedSubscriptionId?: string | null;
  }>;
}

/** A row and, when its source has one, its count's stamp. */
type StampedSubscriptionRow = SubscriptionRow & { unreadCountAsOf?: string };

/**
 * The row to store for `row`: it keeps the stored count when that's newer, and
 * records the stamp of the count it takes.
 */
function withNewestCount(store: SubscriptionStore, row: StampedSubscriptionRow): SubscriptionRow {
  const { unreadCountAsOf, ...rest } = row;
  const stored = store.rows.getSynced(row.id);
  if (stored && !isCountsAsOfNewer(unreadCountAsOf, store.countAsOf.get(row.id))) {
    return { ...rest, unreadCount: stored.unreadCount };
  }
  if (unreadCountAsOf !== undefined) store.countAsOf.set(row.id, unreadCountAsOf);
  return rest;
}

/** Writes rows from an event or mutation response. */
export function writeLiveSubscriptions(
  store: SubscriptionStore,
  rows: StampedSubscriptionRow[]
): void {
  writeLiveRows(
    store,
    rows.map((row) => withNewestCount(store, row))
  );
}

/** Patches a stored subscription from an event; a no-op when it isn't stored. */
export function patchLiveSubscription(
  store: SubscriptionStore,
  id: string,
  patch: Partial<Omit<SubscriptionRow, "unreadCount">>
): void {
  const row = store.rows.getSynced(id);
  if (row) writeLiveRows(store, [{ ...row, ...patch }]);
}

/**
 * Sets a stored subscription's unread count unless a newer one is stored.
 * Returns whether the store holds the subscription.
 */
export function writeSubscriptionCount(
  store: SubscriptionStore,
  id: string,
  unread: number,
  asOf: string | undefined
): boolean {
  const row = store.rows.getSynced(id);
  if (!row) return false;
  if (!isCountsAsOfNewer(asOf, store.countAsOf.get(id))) return true;
  if (asOf !== undefined) store.countAsOf.set(id, asOf);
  if (row.unreadCount !== unread) store.rows.upsert([{ ...row, unreadCount: unread }]);
  return true;
}

/**
 * Stores rows a query fetched, except over a newer version; a row too old to
 * store still brings its count when that's the newest.
 */
export function ingestFetchedSubscriptions(
  store: SubscriptionStore,
  queryHash: string,
  rows: FetchedSubscriptionRow[]
): void {
  const version = fetchVersion(store, queryHash);
  const fresh: SubscriptionRow[] = [];
  for (const row of rows) {
    if (isFetchedRowFresh(store, row.id, version)) {
      store.versions.set(row.id, version);
      fresh.push(withNewestCount(store, row));
    } else {
      writeSubscriptionCount(store, row.id, row.unreadCount, row.unreadCountAsOf);
    }
  }
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
