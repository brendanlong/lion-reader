/**
 * Entry lists: paging, search and counts over `visible_entries`. Reads of
 * whole entries are in `entry-reads.ts`, read and star writes in
 * `entry-state.ts`.
 */

import { z } from "zod";
import { eq, and, desc, asc, sql, isNull, isNotNull, type AnyColumn, type SQL } from "drizzle-orm";
import type { PgSelect } from "drizzle-orm/pg-core";
import type { Temporal } from "temporal-polyfill";
import type { db as dbType } from "@/server/db";
import {
  feeds,
  subscriptionEntries,
  subscriptions,
  tagEntries,
  tags,
  visibleEntries,
} from "@/server/db/schema";
import { getSavedSubscriptionId } from "./subscriptions";
import { parseTimestamptz } from "@/server/db/temporal";
import { errors } from "@/server/errors";
import { createCursorCodec, cursorUuid } from "./cursor";
import { countsAsOfColumn, countsAsOfNow, formatCountsAsOf, getUserUnreadCounts } from "./counts";
import {
  buildEntrySubscriptionFilter,
  buildEntryFilterConditions,
  entryFeedTitleSql,
  entryOriginOn,
  filterableSubscriptionWhere,
  verifySubscriptionOwnership,
  VISIBLE_MEMBERSHIPS,
  VISIBLE_ROW,
} from "./entry-filters";
import { ENTRY_TYPES, type EntryType } from "@/lib/entry-types";
import { entryPositionsSchema } from "@/lib/events/schemas";
import {
  ENTRY_SORT_BYS,
  ENTRY_SORT_DIRECTIONS,
  ENTRY_SORT_ORDERS,
  isRankedSort,
  type EntrySortBy,
  type EntrySortOrder,
  type RankedSortBy,
  sortFieldOf,
} from "@/lib/entry-sort";

// ============================================================================
// Types
// ============================================================================

export interface ListEntriesParams {
  userId: string;
  query?: string; // Optional full-text search query — delegates to searchEntries (#1249)
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  type?: EntryType;
  excludeTypes?: EntryType[];
  unreadOnly?: boolean;
  readOnly?: boolean;
  starredOnly?: boolean;
  unstarredOnly?: boolean;
  /**
   * One of `sortBy`'s two directions (`ENTRY_SORT_DIRECTIONS`), its first by
   * default; alone, it names its sort. With neither, a subscription whose
   * members have positions lists by position, any other list newest first.
   */
  sortOrder?: EntrySortOrder;
  // Which column to sort by (default: published). "published" = publish/fetch
  // time; "readChanged" = read-state-change time (Recently Read, which also
  // excludes never-read entries); "score" and "position" (one subscription's
  // list only) = the user's score or the collection's position, then date
  // (#2064). Each is served by an index.
  sortBy?: EntrySortBy;
  cursor?: string;
  offset?: number; // Skip this many rows (for page/offset-based compat APIs like Wallabag). Mutually exclusive with cursor.
  limit?: number;
  maxLimit?: number; // Override MAX_ENTRIES_PAGE_SIZE (e.g., for Google Reader API which needs larger batches)
  publishedAfter?: Date; // Only entries published/fetched after this timestamp
  publishedBefore?: Date; // Only entries published/fetched before this timestamp
  updatedAfter?: Date; // Only entries modified at/after this timestamp (user_entries.changed_at; powers Wallabag `since` delta sync)
  collectionIdGroups?: string[][]; // See EntryConditionParams.collectionIdGroups
  showSpam: boolean;
}

export interface SearchEntriesParams {
  userId: string;
  query: string;
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  type?: EntryType;
  excludeTypes?: EntryType[];
  unreadOnly?: boolean;
  readOnly?: boolean;
  starredOnly?: boolean;
  unstarredOnly?: boolean;
  cursor?: string;
  offset?: number; // Skip this many rows (for page/offset-based compat APIs like Wallabag). Mutually exclusive with cursor.
  limit?: number;
  maxLimit?: number;
  publishedAfter?: Date;
  publishedBefore?: Date;
  updatedAfter?: Date; // Only entries modified at/after this timestamp (see ListEntriesParams.updatedAfter)
  showSpam: boolean;
}

/**
 * An entry without its content: the item of every surface's lists, and the
 * base of the full entry (`fullEntrySchema`, `entry-reads.ts`).
 */
export const entryListItemSchema = z.object({
  id: z.string(),
  /**
   * The entry's origin (#1846): its membership in a web, email or saved
   * subscription, an active one first (`entryMemberships`).
   */
  subscriptionId: z.string().nullable(),
  /**
   * Every active subscription holding the entry: its origin, its collections,
   * and for a saved article the saved subscription (`entryMemberships`).
   */
  subscriptionIds: z.array(z.string()),
  /** Its position in each of those that gives it one (a collection's order, #2064). */
  positions: entryPositionsSchema,
  type: z.enum(ENTRY_TYPES),
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.date().nullable(),
  fetchedAt: z.date(),
  read: z.boolean(),
  starred: z.boolean(),
  /** When read state last changed (Recently Read's order); null if it never has. */
  readChangedAt: z.date().nullable(),
  /** How much the user wants the article (#2064): higher sorts first; null for none. */
  score: z.number().nullable(),
  /** The later of the entry's and the user's state's updated_at, for cache freshness. */
  updatedAt: z.date(),
  /**
   * When the entry's own fields last changed (`entries.updated_at`), without
   * the user's state: how fresh its metadata is (#1759).
   */
  entryUpdatedAt: z.date(),
  feedTitle: z.string().nullable(),
  siteName: z.string().nullable(),
});

export type EntryListItem = z.infer<typeof entryListItemSchema>;

/**
 * Which ranked sorts a list has values for, so a client offers only those
 * (Date always applies).
 */
export const entrySortableSchema = z.object({
  score: z.boolean(),
  position: z.boolean(),
});

export type EntrySortable = z.infer<typeof entrySortableSchema>;

/**
 * The sort a list is in: the one asked for, or with none, the list's default
 * (a subscription with positions by position, first first; else newest).
 */
export const entrySortSchema = z.object({
  sortBy: z.enum(ENTRY_SORT_BYS),
  sortOrder: z.enum(ENTRY_SORT_ORDERS),
});

export type EntrySort = z.infer<typeof entrySortSchema>;

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50;
/** The most entries one page of a list or search, or one read by id, returns, on every surface. */
export const MAX_ENTRIES_PAGE_SIZE = 100;

// ============================================================================
// Row Mapping Helper
// ============================================================================

/**
 * Shape of a database row from the entry list query (shared across list/search).
 */
interface EntryListRow {
  id: string;
  subscriptionId: string | null;
  subscriptionIds: string[];
  positions: Record<string, number>;
  type: EntryType;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  updatedAt: Date;
  entryUpdatedAt: Date;
  read: boolean;
  starred: boolean;
  readChangedAt: Date | null;
  score: number | null;
  siteName: string | null;
  feedTitle: string | null;
}

/**
 * Maps a database row to an EntryListItem.
 */
function toEntryListItem(row: EntryListRow): EntryListItem {
  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    subscriptionIds: row.subscriptionIds,
    positions: row.positions,
    type: row.type,
    url: row.url,
    title: row.title,
    author: row.author,
    summary: row.summary,
    publishedAt: row.publishedAt,
    fetchedAt: row.fetchedAt,
    read: row.read,
    starred: row.starred,
    readChangedAt: row.readChangedAt,
    score: row.score,
    updatedAt: row.updatedAt,
    entryUpdatedAt: row.entryUpdatedAt,
    feedTitle: row.feedTitle,
    siteName: row.siteName,
  };
}

// ============================================================================
// Cursor Helpers
// ============================================================================

// The two entry cursors share a `{ ts, id }` shape but differ in what `ts`
// means, so each validates it: an ISO timestamp for the timeline (cast to
// ::timestamptz), a float rank for search (compared against the rank column).
// Rejecting here keeps a bad value from surfacing as a Postgres cast 500 or a
// NaN comparison.
const timelineCursor = createCursorCodec(
  z.object({
    ts: z.string().refine((ts) => !Number.isNaN(Date.parse(ts))),
    id: cursorUuid,
  })
);

/** A ranked sort's: the row's value, null once the page is in the rows without one. */
const rankedCursor = createCursorCodec(
  z.object({
    value: z.number().finite().nullable(),
    ts: z.string().refine((ts) => !Number.isNaN(Date.parse(ts))),
    id: cursorUuid,
  })
);

const searchCursor = createCursorCodec(
  z.object({
    ts: z.string().refine((ts) => Number.isFinite(parseFloat(ts))),
    id: cursorUuid,
  })
);

/**
 * Columns shared by the list and search queries (each adds its feed title and
 * sort key). Callers must LEFT JOIN `feeds` on the owner feed.
 */
const entryListSelectFields = {
  id: visibleEntries.id,
  type: visibleEntries.type,
  url: visibleEntries.url,
  title: visibleEntries.title,
  author: visibleEntries.author,
  summary: visibleEntries.summary,
  publishedAt: visibleEntries.publishedAt,
  fetchedAt: visibleEntries.fetchedAt,
  read: visibleEntries.read,
  starred: visibleEntries.starred,
  readChangedAt: visibleEntries.readChangedAt,
  score: visibleEntries.score,
  updatedAt: visibleEntries.updatedAt,
  entryUpdatedAt: visibleEntries.entryUpdatedAt,
  subscriptionId: subscriptions.id,
  subscriptionIds: VISIBLE_MEMBERSHIPS.subscriptionIds,
  positions: VISIBLE_MEMBERSHIPS.positions,
  siteName: visibleEntries.siteName,
};

/**
 * The rows a list has of its own, which carry its sort key and copies of each
 * article's state: one subscription's memberships (the `subscriptionId`
 * filter, which the caller checks is the user's, or Saved's), or a
 * tag's or Uncategorized's `tag_entries`, which hold no spam, so a showSpam
 * tag list filters the timeline instead. Null for All and Starred, which read
 * `user_entries` itself. Joined on the user too: a list id alone
 * (Uncategorized's is the user's id) must never reach another user's rows
 * (SECURITY.md §7).
 */
async function listRowsOf(db: typeof dbType, params: Omit<ListEntriesParams, "query">) {
  const subscriptionId =
    params.subscriptionId ??
    (params.type === "saved" && !params.tagId && !params.uncategorized
      ? await getSavedSubscriptionId(db, params.userId)
      : null);
  const tagListId = params.showSpam
    ? null
    : (params.tagId ?? (params.uncategorized ? params.userId : null));
  const rows = subscriptionId
    ? { table: subscriptionEntries, inList: eq(subscriptionEntries.subscriptionId, subscriptionId) }
    : tagListId
      ? { table: tagEntries, inList: eq(tagEntries.listId, tagListId) }
      : null;
  if (!rows) return null;
  const { table } = rows;
  return {
    table,
    on: and(
      rows.inList,
      eq(table.userId, visibleEntries.userId),
      eq(table.entryId, visibleEntries.id)
    )!,
    savedOnly: !params.subscriptionId && !params.tagId && !params.uncategorized,
  };
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Lists entries with filters and pagination.
 *
 * If query is provided, performs full-text search across title and content.
 * Otherwise, returns entries filtered by metadata and sorted by `sortBy`, and
 * its first page says which ranked sorts the list has values for.
 */
export async function listEntries(
  db: typeof dbType,
  params: ListEntriesParams
): Promise<{
  items: EntryListItem[];
  nextCursor?: string;
  sortable?: EntrySortable;
  sort?: EntrySort;
}> {
  // If query is provided, delegate to search implementation (indexed full-text
  // search over the stored entries.search_vector column — see searchEntries).
  if (params.query) {
    assertOnePaging(params);
    return searchEntries(db, {
      ...params,
      query: params.query,
      showSpam: params.showSpam,
    });
  }

  const page = await planEntryPage(db, params);
  if (!page) return { items: [] };

  const [{ items, nextCursor }, sortable] = await Promise.all([
    page.read(() =>
      db
        .select({
          ...entryListSelectFields,
          feedTitle: entryFeedTitleSql(),
          ...page.sortFields,
        })
        .from(visibleEntries)
        .leftJoin(feeds, eq(visibleEntries.ownerFeedId, feeds.id))
        .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
        .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
        .$dynamic()
    ),
    params.cursor || params.offset ? undefined : listSortable(db, params, page),
  ]);
  const firstPage = !params.cursor && !params.offset;
  return {
    items: items.map(toEntryListItem),
    nextCursor,
    ...(sortable && { sortable }),
    ...(firstPage && page.sort && { sort: page.sort }),
  };
}

/**
 * Which ranked sorts the list has values for, ignoring spam: a showSpam tag
 * or Uncategorized list has no rows of its own (`tag_entries` hold no spam),
 * so its lookup would walk every scored article the user has. A scored spam
 * article alone doesn't offer the sort.
 */
async function listSortable(
  db: typeof dbType,
  params: ListEntriesParams,
  page: NonNullable<Awaited<ReturnType<typeof planEntryPage>>>
): Promise<EntrySortable | undefined> {
  if (!params.showSpam) return page.sortable();
  return (await planEntryPage(db, { ...params, showSpam: false }))?.sortable();
}

/** An entry as Google Reader's item lists key it (`listGreaderItemRefs`). */
export interface GreaderItemRef {
  id: string;
  /** `entries.greader_item_id`, the item's id on the wire. */
  itemId: bigint;
  /**
   * The origin subscription's feed stream serial (for a saved article, the
   * saved subscription's, which clients see as "Saved Articles", #730); null
   * if the entry has no origin.
   */
  originStreamId: bigint | null;
  fetchedAt: Date;
}

/**
 * One page of `listEntries` holding only what Google Reader's stream
 * endpoints key items on: each entry's serials and fetch time, read with the
 * page in one statement, so stream/items/ids (up to 10,000 a page) reads no
 * content and stream/contents reads each entry's once (`getEntries`). Its own
 * type keeps the bigint serials off the shared entry types, which other
 * surfaces serialize as they are.
 */
export async function listGreaderItemRefs(
  db: typeof dbType,
  params: Omit<ListEntriesParams, "query">
): Promise<{ items: GreaderItemRef[]; nextCursor?: string }> {
  const page = await planEntryPage(db, params);
  if (!page) return { items: [] };

  const { items, nextCursor } = await page.read(() =>
    db
      .select({
        id: visibleEntries.id,
        itemId: visibleEntries.greaderItemId,
        originStreamId: subscriptions.greaderStreamId,
        fetchedAt: visibleEntries.fetchedAt,
        ...page.sortFields,
      })
      .from(visibleEntries)
      .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
      .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
      .$dynamic()
  );
  return {
    items: items.map((row) => ({
      id: row.id,
      itemId: row.itemId,
      originStreamId: row.originStreamId,
      fetchedAt: row.fetchedAt,
    })),
    nextCursor,
  };
}

/** The read and starred filters, on a list row's copies of them. */
function listRowStateConditions(
  table: typeof subscriptionEntries | typeof tagEntries,
  params: Omit<ListEntriesParams, "query">
): SQL[] {
  const conditions: SQL[] = [];
  if (params.unreadOnly) conditions.push(sql`NOT ${table.read}`);
  else if (params.readOnly) conditions.push(sql`${table.read}`);
  if (params.starredOnly) conditions.push(sql`${table.starred}`);
  else if (params.unstarredOnly) conditions.push(sql`NOT ${table.starred}`);
  return conditions;
}

/**
 * `cursor` and `offset` are two different ways to page and must not be
 * combined: the cursor predicate would narrow the window and offset would then
 * skip *more* rows on top of it, silently double-skipping.
 */
function assertOnePaging(params: { cursor?: string; offset?: number }): void {
  if (params.cursor && params.offset) {
    throw new Error("listEntries: `cursor` and `offset` are mutually exclusive");
  }
}

/** The columns a page's rows are ordered by, in their index's order. */
type SortKeys = readonly [value: AnyColumn, ts: AnyColumn, id: AnyColumn];

/**
 * The ORDER BY of a scan of an index on (`keys`), every column `DESC` or
 * every column `ASC`, with `NULLS LAST`: spelled exactly as the scan returns
 * rows, read forward or backward, or Postgres sorts the whole range instead.
 */
function indexScanOrder(keys: SortKeys, indexDesc: boolean, forward: boolean): SQL[] {
  const direction = sql.raw(indexDesc === forward ? "DESC" : "ASC");
  const nulls = sql.raw(forward ? "NULLS LAST" : "NULLS FIRST");
  const [value, ts, id] = keys;
  return [sql`${value} ${direction} ${nulls}`, sql`${ts} ${direction}`, sql`${id} ${direction}`];
}

/** The row comparison selecting rows after `bound` in a scan's order. */
function afterInScan(columns: AnyColumn[], bound: SQL[], descending: boolean): SQL {
  return sql`(${sql.join(columns, sql`, `)}) ${sql.raw(descending ? "<" : ">")} (${sql.join(bound, sql`, `)})`;
}

/**
 * A ranked sort's rows and their index: one subscription's memberships for a
 * position, the list's rows (or `user_entries`) for a score, whose copies
 * sort each list's index. Score indexes are `DESC`, position ones `ASC`.
 */
function rankedSortKeys(
  sortBy: RankedSortBy,
  listRows: ListRows | null
): { keys: SortKeys; indexDesc: boolean } {
  if (sortBy === "position") {
    return {
      keys: [
        subscriptionEntries.position,
        subscriptionEntries.publishedOrFetchedAt,
        subscriptionEntries.entryId,
      ],
      indexDesc: false,
    };
  }
  const { table } = listRows ?? {};
  return {
    keys: table
      ? [table.score, table.publishedOrFetchedAt, table.entryId]
      : [visibleEntries.score, visibleEntries.publishedOrFetchedAt, visibleEntries.id],
    indexDesc: true,
  };
}

type ListRows = NonNullable<Awaited<ReturnType<typeof listRowsOf>>>;

/** A row of a page, with the sort key `planEntryPage`'s `sortFields` selects. */
interface PageRow {
  id: string;
  sortTs: Temporal.Instant;
  sortValue: number | null;
}

/**
 * The sort and its direction, validated: each sort has its own pair of
 * directions (`ENTRY_SORT_DIRECTIONS`), position orders only one
 * subscription's list, and read time only the user's whole history. A direction alone names its sort; with neither, the
 * list's default (`defaultSortBy`).
 */
function resolveSort(
  params: Omit<ListEntriesParams, "query">,
  defaultSortBy: "published" | "position"
) {
  const sortBy =
    params.sortBy ?? (params.sortOrder ? sortFieldOf(params.sortOrder) : defaultSortBy);
  const directions = ENTRY_SORT_DIRECTIONS[sortBy];
  const sortOrder = params.sortOrder ?? directions[0];
  if (!(directions as readonly string[]).includes(sortOrder)) {
    throw errors.validation(`Sort by ${sortBy} is ${directions.join(" or ")}, not ${sortOrder}`);
  }
  if (sortBy === "position" && !params.subscriptionId) {
    throw errors.validation("Only a collection's list (subscriptionId) can sort by position");
  }
  // A list with rows of its own has no read-time index, and nothing needs one
  // (#2114): Recently Read is the user's whole history.
  if (
    sortBy === "readChanged" &&
    (params.subscriptionId || params.tagId || params.uncategorized || params.type === "saved")
  ) {
    throw errors.validation("Recently Read covers every subscription; it can't be filtered to one");
  }
  if (isRankedSort(sortBy) && params.offset) {
    throw errors.validation(`A list sorted by ${sortBy} pages by cursor, not offset`);
  }
  return { sortBy, sortOrder, reversed: sortOrder === directions[1] };
}

/** Whether any of a list's rows (with its filters) has a value for `sort`. */
async function listHasValues(
  db: typeof dbType,
  conditions: SQL[],
  listRows: ListRows | null,
  sort: RankedSortBy
): Promise<boolean> {
  const { keys, indexDesc } = rankedSortKeys(sort, listRows);
  const query = db
    .select({ one: sql`1` })
    .from(visibleEntries)
    .$dynamic();
  const rows = await (listRows ? query.innerJoin(listRows.table, listRows.on) : query)
    .where(and(...conditions, isNotNull(keys[0])))
    .orderBy(...indexScanOrder(keys, indexDesc, true))
    .limit(1);
  return rows.length > 0;
}

/** Whether a cursor is a ranked sort's (it carries the row's value). */
function isRankedCursor(cursor: string): boolean {
  try {
    rankedCursor.decode(cursor);
    return true;
  } catch {
    return false;
  }
}

/**
 * One `listEntries` page's filters, order and window: `read` runs it over a
 * select on `visible_entries` (which must select `sortFields`), and
 * `sortable` says which ranked sorts the list has values for. Null when the
 * page is empty without a query (a subscription filter the user can't use).
 */
async function planEntryPage(db: typeof dbType, params: Omit<ListEntriesParams, "query">) {
  assertOnePaging(params);

  const effectiveMaxLimit = params.maxLimit ?? MAX_ENTRIES_PAGE_SIZE;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, effectiveMaxLimit);

  const conditions = [eq(visibleEntries.userId, params.userId)];

  // A subscription filter must be the user's; a tag's or Uncategorized's rows
  // are by the join on them, and without rows (showSpam) its filter is.
  const listRows = await listRowsOf(db, params);
  if (listRows) {
    if (
      params.subscriptionId &&
      !(await verifySubscriptionOwnership(db, params.subscriptionId, params.userId))
    ) {
      return null;
    }
  } else {
    const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, params.userId, {
      paged: true,
    });
    if (subscriptionFilter === null) return null;
    if (subscriptionFilter) conditions.push(subscriptionFilter);
  }

  if (listRows) {
    conditions.push(...listRowStateConditions(listRows.table, params));
  }

  // Apply entry filter conditions (read/starred/type/spam/timestamp filters).
  // Saved is the saved subscription's list, which `listRows` already is. A
  // list's rows filter read and starred on their copies alone: the triggers
  // write those in the article's own transaction, and filtering both would
  // have Postgres multiply two identical selectivities, guess a page holds
  // fewer rows than it does, and sort the whole list instead. Spam, which is
  // rare and never changes, is filtered on the joined user_entries row.
  conditions.push(
    ...buildEntryFilterConditions(
      listRows
        ? {
            ...params,
            type: listRows.savedOnly ? undefined : params.type,
            unreadOnly: undefined,
            readOnly: undefined,
            starredOnly: undefined,
            unstarredOnly: undefined,
          }
        : params
    )
  );

  // A request that names no sort gets the list's default: a subscription
  // whose members have positions (with the list's filters) in their order, so
  // a book opens at its first chapter, and any other list newest first. A
  // cursor carries the sort its first page used.
  const positionable = !!params.subscriptionId && listRows?.table === subscriptionEntries;
  const hasPositions =
    positionable && !params.sortBy && !params.sortOrder
      ? params.cursor
        ? isRankedCursor(params.cursor)
        : await listHasValues(db, conditions, listRows, "position")
      : undefined;
  const { sortBy, sortOrder, reversed } = resolveSort(
    params,
    hasPositions ? "position" : "published"
  );

  // A list with rows of its own (one subscription's, a tag's, Uncategorized's)
  // joins them, which can't fan out, and pages through their index: walking
  // the user's timeline instead reads every article outside the list.
  const timelineSort = sortBy !== "readChanged";

  // Recently Read lists only entries whose read state was ever set.
  if (!timelineSort) {
    conditions.push(isNotNull(visibleEntries.readChangedAt));
  }

  // Sort column: the timeline ("published", and the date ranked sorts break
  // ties by), or when read state last changed ("readChanged").
  const sortColumn = !timelineSort
    ? visibleEntries.readChangedAt
    : listRows
      ? listRows.table.publishedOrFetchedAt
      : visibleEntries.publishedOrFetchedAt;
  const idColumn = listRows ? listRows.table.entryId : visibleEntries.id;
  const ranked = isRankedSort(sortBy) ? rankedSortKeys(sortBy, listRows) : null;

  const joinRows = <T extends PgSelect>(query: T) =>
    listRows ? query.innerJoin(listRows.table, listRows.on) : query;

  const paginate = <R extends PageRow>(rows: R[]): { items: R[]; nextCursor?: string } => {
    if (rows.length <= limit) return { items: rows };
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    if (!last) return { items };
    const position = { ts: last.sortTs.toString(), id: last.id };
    return {
      items,
      nextCursor: ranked
        ? rankedCursor.encode({ value: last.sortValue, ...position })
        : timelineCursor.encode(position),
    };
  };

  /**
   * A ranked sort's page: the rows with a value, in the requested direction,
   * then those without, newest first, each one range of the index. The
   * cursor says which range the page starts in.
   */
  const readRanked = async <T extends PgSelect>(
    { keys, indexDesc }: NonNullable<typeof ranked>,
    build: () => T
  ): Promise<{ items: Awaited<T>; nextCursor?: string }> => {
    const [value, ts, id] = keys;
    const cursor = params.cursor ? rankedCursor.decode(params.cursor) : undefined;
    const tsBound = cursor && [sql`${cursor.ts}::timestamptz`, sql`${cursor.id}::uuid`];
    const rows: PageRow[] = [];

    if (cursor?.value !== null) {
      const forward = !reversed;
      const valued = [...conditions, isNotNull(value)];
      if (cursor && tsBound) {
        valued.push(
          afterInScan(
            [value, ts, id],
            [sql`${cursor.value}::float8`, ...tsBound],
            indexDesc === forward
          )
        );
      }
      const page = await joinRows(build())
        .where(and(...valued))
        .orderBy(...indexScanOrder(keys, indexDesc, forward))
        .limit(limit + 1);
      rows.push(...(page as PageRow[]));
    }
    if (rows.length <= limit) {
      // Newest first: the scan of an ASC index runs backward.
      const unvalued = [...conditions, isNull(value)];
      if (cursor?.value === null && tsBound) {
        unvalued.push(afterInScan([ts, id], tsBound, true));
      }
      const page = await joinRows(build())
        .where(and(...unvalued))
        .orderBy(...indexScanOrder(keys, indexDesc, indexDesc))
        .limit(limit + 1 - rows.length);
      rows.push(...(page as PageRow[]));
    }
    const { items, nextCursor } = paginate(rows);
    return { items: items as Awaited<T>, nextCursor };
  };

  const readByDate = async <T extends PgSelect>(
    build: () => T
  ): Promise<{ items: Awaited<T>; nextCursor?: string }> => {
    const descending = !reversed;
    const page = [...conditions];
    // A row comparison, never the `OR` form (#2067; "Ordering & Pagination" in
    // src/server/CLAUDE.md). The timestamp goes to Postgres as text
    // (::timestamptz) to keep its microseconds.
    if (params.cursor) {
      const { ts, id } = timelineCursor.decode(params.cursor);
      page.push(
        afterInScan([sortColumn, idColumn], [sql`${ts}::timestamptz`, sql`${id}::uuid`], descending)
      );
    }
    // visible_entries emits exactly one row per (user, entry), and so does a
    // join on a list's rows (one per list and article), so no DISTINCT ON
    // dedup is needed and the (sortColumn, id) keyset cursor resumes cleanly
    // over unique rows.
    const rows = await joinRows(build())
      .where(and(...page))
      .orderBy(
        ...(descending ? [desc(sortColumn), desc(idColumn)] : [asc(sortColumn), asc(idColumn)])
      )
      .limit(limit + 1)
      .offset(params.offset ?? 0);
    const { items, nextCursor } = paginate(rows as PageRow[]);
    return { items: items as Awaited<T>, nextCursor };
  };

  return {
    sortFields: {
      // Full-precision sort key for cursor encoding. The pool hands back
      // Postgres's raw microsecond string for timestamptz (see parseTimestamptz);
      // mapWith decodes it to a Temporal.Instant so the cursor never loses the
      // microseconds a JS Date would truncate — which corrupted keyset pagination
      // (#680, #683).
      sortTs: sql`${sortColumn}`.mapWith(parseTimestamptz),
      sortValue: ranked ? sql<number | null>`${ranked.keys[0]}`.mapWith(Number) : sql<null>`NULL`,
    },

    read: <T extends PgSelect>(build: () => T) =>
      ranked ? readRanked(ranked, build) : readByDate(build),

    /**
     * Which ranked sorts the list has values for, with its filters (Date
     * always applies): a score anywhere in it, a position in one
     * subscription's list. Undefined for Recently Read, which sorts by
     * nothing else.
     */
    sortable: async (): Promise<EntrySortable | undefined> => {
      if (!timelineSort) return undefined;
      const [score, positioned] = await Promise.all([
        listHasValues(db, conditions, listRows, "score"),
        positionable && (hasPositions ?? listHasValues(db, conditions, listRows, "position")),
      ]);
      return { score, position: positioned };
    },

    /** The sort the page is in, for a client ordering it locally. */
    sort: { sortBy, sortOrder },
  };
}

/**
 * Full-text search over entries, ranked by relevance. Matches and ranks against
 * the stored, GIN-indexed `entries.search_vector` (title + cleaned body, falling
 * back to raw content; see migration 0105) rather than tokenizing bodies on the
 * fly, so it no longer scans the user's whole history per query (#1249).
 */
async function searchEntries(
  db: typeof dbType,
  params: SearchEntriesParams
): Promise<{ items: EntryListItem[]; nextCursor?: string }> {
  const effectiveMaxLimit = params.maxLimit ?? MAX_ENTRIES_PAGE_SIZE;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, effectiveMaxLimit);

  const conditions = [eq(visibleEntries.userId, params.userId)];

  // Match and rank against the stored, GIN-indexed tsvector (title + cleaned
  // body, falling back to raw content when cleaned is empty — see migration
  // 0105). Reading the precomputed column means the `@@` lookup is served by
  // idx_entries_search_vector and ts_rank doesn't re-tokenize each matching
  // document, which is what made the old on-the-fly to_tsvector search scan and
  // tokenize the user's entire history on every query (#1249).
  const searchQuery = sql`plainto_tsquery('english', ${params.query})`;
  conditions.push(sql`${visibleEntries.searchVector} @@ ${searchQuery}`);

  const rankColumn = sql<number>`ts_rank(${visibleEntries.searchVector}, ${searchQuery})`;

  // Apply subscription filters (subscriptionId, tagId, uncategorized)
  const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, params.userId, {
    paged: true,
  });
  if (subscriptionFilter === null) {
    return { items: [], nextCursor: undefined };
  }
  if (subscriptionFilter) {
    conditions.push(subscriptionFilter);
  }

  // Apply entry filter conditions (read/starred/type/spam/timestamp filters)
  conditions.push(...buildEntryFilterConditions(params));

  // Cursor for search results (based on rank)
  if (params.cursor) {
    const { ts: rankStr, id } = searchCursor.decode(params.cursor);
    const cursorRank = parseFloat(rankStr);
    conditions.push(
      sql`(${rankColumn} < ${cursorRank} OR (${rankColumn} = ${cursorRank} AND ${visibleEntries.id} < ${id}))`
    );
  }

  // Compute the rank in a subquery so it becomes a plain output column the
  // outer query can ORDER BY and the keyset cursor can compare against:
  // Postgres treats two inlined `ts_rank(...)` expressions as unequal because
  // their bound-parameter placeholders differ ($1 vs $6), so the rank must be a
  // single named column. The view emits one row per (user, entry), so no
  // DISTINCT ON dedup is needed and the (rank, id) cursor resumes cleanly.
  const rankedSubquery = db
    .select({
      ...entryListSelectFields,
      // Aliases: the origin's columns share names with the view's and the
      // feed's, and raw SQL can't be read back through a subquery without one.
      subscriptionId: sql<string | null>`${subscriptions.id}`.as("origin_subscription_id"),
      subscriptionIds: VISIBLE_MEMBERSHIPS.subscriptionIds,
      // Alias to avoid colliding with visibleEntries.title (both are "title")
      // inside the subquery, which would make the outer reference ambiguous.
      feedTitle: entryFeedTitleSql().as("feed_title"),
      // Alias required so the outer query can reference this raw SQL field.
      rank: rankColumn.as("rank"),
    })
    .from(visibleEntries)
    .leftJoin(feeds, eq(visibleEntries.ownerFeedId, feeds.id))
    .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
    .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
    .where(and(...conditions))
    .as("ranked");

  const queryResults = await db
    .select()
    .from(rankedSubquery)
    .orderBy(desc(rankedSubquery.rank), desc(rankedSubquery.id))
    .limit(limit + 1)
    .offset(params.offset ?? 0);

  const hasMore = queryResults.length > limit;
  const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;
  const items = resultEntries.map(toEntryListItem);

  let nextCursor: string | undefined;
  if (hasMore && resultEntries.length > 0) {
    const lastEntry = resultEntries[resultEntries.length - 1];
    // Drizzle infers the sql<number> rank column as `never` through the subquery
    // boundary; Number() recovers the value (a float rank) for cursor encoding.
    nextCursor = searchCursor.encode({ ts: Number(lastEntry.rank).toString(), id: lastEntry.id });
  }

  return { items, nextCursor };
}

/**
 * The lists `countEntries` counts: All (no scope) or exactly one of these,
 * each of which has a trigger-maintained counter.
 */
export interface CountEntriesParams {
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  type?: "saved";
  starredOnly?: boolean;
}

/**
 * Counts the unread articles of one list (All, Starred, Saved, Uncategorized,
 * a tag or a subscription of any type) by reading its counter
 * (`services/counts.ts`), never by scanning. Spam is never counted (#1117),
 * whatever the list's showSpam.
 *
 * Returns 0 where the list shows nothing: a subscription or tag that isn't
 * the user's, or is unsubscribed or deleted. Combining scopes has no counter,
 * so it's rejected.
 */
export async function countEntries(
  db: typeof dbType,
  userId: string,
  params: CountEntriesParams
): Promise<{ unread: number; asOf: string }> {
  const scopes = [
    params.subscriptionId,
    params.tagId,
    params.uncategorized,
    params.type,
    params.starredOnly,
  ].filter(Boolean);
  if (scopes.length > 1) {
    throw errors.validation(
      "Count one list at a time: pass at most one of subscriptionId, tagId, uncategorized, type and starredOnly"
    );
  }

  if (params.subscriptionId) {
    const [row] = await db
      .select({ unread: subscriptions.unreadCount, asOf: countsAsOfColumn() })
      .from(subscriptions)
      .where(filterableSubscriptionWhere(userId, params.subscriptionId));
    return {
      unread: row?.unread ?? 0,
      asOf: formatCountsAsOf(row?.asOf ?? (await countsAsOfNow(db))),
    };
  }

  if (params.tagId) {
    const [row] = await db
      .select({ unread: tags.unreadCount, asOf: countsAsOfColumn() })
      .from(tags)
      .where(and(eq(tags.id, params.tagId), eq(tags.userId, userId), isNull(tags.deletedAt)));
    return {
      unread: row?.unread ?? 0,
      asOf: formatCountsAsOf(row?.asOf ?? (await countsAsOfNow(db))),
    };
  }

  const counts = await countUserLists(db, userId);
  if (params.uncategorized) return { unread: counts.uncategorized, asOf: counts.asOf };
  if (params.type === "saved") return { unread: counts.saved, asOf: counts.asOf };
  if (params.starredOnly) return { unread: counts.starred, asOf: counts.asOf };
  return { unread: counts.all, asOf: counts.asOf };
}

/**
 * The unread counts of the lists that aren't a subscription or tag, from one
 * read: the sidebar shows them together, so it fetches them together.
 */
export async function countUserLists(
  db: typeof dbType,
  userId: string
): Promise<{ all: number; starred: number; saved: number; uncategorized: number; asOf: string }> {
  const counts = await getUserUnreadCounts(db, userId);
  return {
    all: counts.allUnread,
    starred: counts.starredUnread,
    saved: counts.savedUnread,
    uncategorized: counts.uncategorizedUnread,
    asOf: formatCountsAsOf(counts.asOf),
  };
}

/**
 * Counts the entries matching filters, for Wallabag's pagination totals. A
 * scan: never use it for an unread count, which `countEntries` reads from the
 * counters.
 */
export async function countTotalEntries(
  db: typeof dbType,
  userId: string,
  params: {
    subscriptionId?: string;
    tagId?: string;
    uncategorized?: boolean;
    type?: EntryType;
    excludeTypes?: EntryType[];
    unreadOnly?: boolean;
    readOnly?: boolean;
    starredOnly?: boolean;
    unstarredOnly?: boolean;
    updatedAfter?: Date;
    collectionIdGroups?: string[][];
    showSpam: boolean;
  }
): Promise<number> {
  const conditions = [eq(visibleEntries.userId, userId)];

  const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, userId);
  if (subscriptionFilter === null) {
    return 0;
  }
  if (subscriptionFilter) {
    conditions.push(subscriptionFilter);
  }

  conditions.push(...buildEntryFilterConditions(params));

  // One row per (user, entry), so count(*) is exact.
  // eslint-disable-next-line no-restricted-syntax -- Wallabag page total, not an unread count
  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(visibleEntries)
    .where(and(...conditions));

  return result[0]?.total ?? 0;
}
