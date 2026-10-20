/**
 * Entry lists: paging, search and counts over `visible_entries`. Reads of
 * whole entries are in `entry-reads.ts`, read and star writes in
 * `entry-state.ts`.
 */

import { z } from "zod";
import { eq, and, desc, asc, sql, isNull, isNotNull, type SQL } from "drizzle-orm";
import type { PgSelect } from "drizzle-orm/pg-core";
import type { Temporal } from "temporal-polyfill";
import type { db as dbType } from "@/server/db";
import {
  feeds,
  subscriptionEntries,
  subscriptions,
  tags,
  visibleEntries,
} from "@/server/db/schema";
import { getSavedSubscriptionId } from "./subscriptions";
import { parseTimestamptzOrNull } from "@/server/db/temporal";
import { errors } from "@/server/errors";
import { createCursorCodec, cursorUuid } from "./cursor";
import { countsAsOfColumn, countsAsOfNow, formatCountsAsOf, getUserUnreadCounts } from "./counts";
import {
  buildEntrySubscriptionFilter,
  buildEntryFilterConditions,
  entryFeedTitleSql,
  entryOriginOn,
  filterableSubscriptionWhere,
  VISIBLE_MEMBERSHIPS,
  VISIBLE_ROW,
} from "./entry-filters";
import { ENTRY_TYPES, type EntryType } from "@/lib/entry-types";

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
  sortOrder?: "newest" | "oldest";
  // Which column to sort by (default: published). "published" = publish/fetch
  // time (index-backed); "readChanged" = read-state-change time (the recently-read
  // view, which also excludes never-read entries); "archived" = read-state-change
  // time WITHOUT the recently-read exclusion (Wallabag sort=archived). All three
  // are served by an existing index. There is no "updated" sort: the Wallabag
  // route approximates sort=updated as the default published sort.
  sortBy?: "published" | "readChanged" | "archived";
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
  updatedAt: visibleEntries.updatedAt,
  entryUpdatedAt: visibleEntries.entryUpdatedAt,
  subscriptionId: subscriptions.id,
  subscriptionIds: VISIBLE_MEMBERSHIPS.subscriptionIds,
  siteName: visibleEntries.siteName,
};

/**
 * The one subscription a list shows, when it shows exactly one: the
 * `subscriptionId` filter (already checked by `buildEntrySubscriptionFilter`)
 * or, for Saved, the saved subscription.
 */
async function singleSubscriptionOf(
  db: typeof dbType,
  params: ListEntriesParams
): Promise<string | null> {
  if (params.tagId || params.uncategorized) return null;
  if (params.subscriptionId) return params.subscriptionId;
  if (params.type === "saved") return getSavedSubscriptionId(db, params.userId);
  return null;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Lists entries with filters and pagination.
 *
 * If query is provided, performs full-text search across title and content.
 * Otherwise, returns entries filtered by metadata and sorted by time.
 */
export async function listEntries(
  db: typeof dbType,
  params: ListEntriesParams
): Promise<{ items: EntryListItem[]; nextCursor?: string }> {
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

  const rows = await page.apply(
    db
      .select({
        ...entryListSelectFields,
        feedTitle: entryFeedTitleSql(),
        sortTs: page.sortTs,
      })
      .from(visibleEntries)
      .leftJoin(feeds, eq(visibleEntries.ownerFeedId, feeds.id))
      .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
      .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
      .$dynamic()
  );
  const { items, nextCursor } = page.paginate(rows);
  return { items: items.map(toEntryListItem), nextCursor };
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

  const rows = await page.apply(
    db
      .select({
        id: visibleEntries.id,
        itemId: visibleEntries.greaderItemId,
        originStreamId: subscriptions.greaderStreamId,
        fetchedAt: visibleEntries.fetchedAt,
        sortTs: page.sortTs,
      })
      .from(visibleEntries)
      .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
      .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
      .$dynamic()
  );
  const { items, nextCursor } = page.paginate(rows);
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

/** The read, starred and spam filters, on a membership's copies of them. */
function membershipStateConditions(params: Omit<ListEntriesParams, "query">): SQL[] {
  const conditions: SQL[] = [];
  if (params.unreadOnly) conditions.push(sql`NOT ${subscriptionEntries.read}`);
  else if (params.readOnly) conditions.push(sql`${subscriptionEntries.read}`);
  if (params.starredOnly) conditions.push(sql`${subscriptionEntries.starred}`);
  else if (params.unstarredOnly) conditions.push(sql`NOT ${subscriptionEntries.starred}`);
  if (!params.showSpam) conditions.push(sql`NOT ${subscriptionEntries.isSpam}`);
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

/**
 * One `listEntries` page's filters, order and window, for a select over
 * `visible_entries` to `apply`, and `paginate` to split its rows into the
 * page and the next cursor. Null when the page is empty without a query (a
 * subscription filter the user can't use).
 */
async function planEntryPage(db: typeof dbType, params: Omit<ListEntriesParams, "query">) {
  assertOnePaging(params);

  const effectiveMaxLimit = params.maxLimit ?? MAX_ENTRIES_PAGE_SIZE;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, effectiveMaxLimit);
  const sortOrder = params.sortOrder ?? "newest";

  const conditions = [eq(visibleEntries.userId, params.userId)];

  // Apply subscription filters (subscriptionId, tagId, uncategorized)
  const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, params.userId, {
    paged: true,
  });
  if (subscriptionFilter === null) return null;

  // One subscription's list (a subscription filter, or Saved) joins that
  // subscription's memberships, which can't fan out. Sorted by the timeline,
  // it walks them (idx_subscription_entries_timeline, whose sort key is the
  // row's) rather than the user's timeline, which may hold them sparsely.
  // Sorted otherwise, the join still lets Postgres start from the
  // memberships when they're few, where an EXISTS filter left it walking the
  // user's whole history for a sparse page (Wallabag's Saved by `archived`).
  const timelineSort = params.sortBy !== "readChanged" && params.sortBy !== "archived";
  const single = await singleSubscriptionOf(db, params);
  if (subscriptionFilter && !single) {
    conditions.push(subscriptionFilter);
  }
  if (single) {
    // The membership's copies of the row's state (the row's own still apply),
    // so a filtered page of one subscription reads its index of matches.
    conditions.push(...membershipStateConditions(params));
  }

  // Apply entry filter conditions (read/starred/type/spam/timestamp filters).
  // Saved is the saved subscription's list, which `single` already is.
  conditions.push(
    ...buildEntryFilterConditions(
      single && !params.subscriptionId && params.type === "saved"
        ? { ...params, type: undefined }
        : params
    )
  );

  // Recently Read: exclude entries that were never explicitly read-state-changed.
  // This exclusion is specific to that view (sortBy=readChanged); the Wallabag
  // "archived" sort orders by the same column but keeps unarchived entries.
  if (params.sortBy === "readChanged") {
    conditions.push(isNotNull(visibleEntries.readChangedAt));
  }

  // Sort column: the timeline ("published"), or when read state last changed
  // ("readChanged"/"archived"). Each list's page must read about its own size
  // in rows, whatever else the user has: `list-page-bounds.test.ts` holds every
  // list and filter to that, so a new one needs an index there.
  const sortColumn = !timelineSort
    ? visibleEntries.readChangedAt
    : single
      ? subscriptionEntries.publishedOrFetchedAt
      : visibleEntries.publishedOrFetchedAt;
  const idColumn = single && timelineSort ? subscriptionEntries.entryId : visibleEntries.id;

  // A row comparison, which Postgres reads as a bound on the index; the
  // equivalent `a < x OR (a = x AND b < y)` is a filter, so every page would
  // read the list from its top (#2067). The timestamp goes to Postgres as text
  // (::timestamptz) to keep its microseconds.
  if (params.cursor) {
    const { ts, id } = timelineCursor.decode(params.cursor);
    conditions.push(
      sortOrder === "newest"
        ? sql`(${sortColumn}, ${idColumn}) < (${ts}::timestamptz, ${id}::uuid)`
        : sql`(${sortColumn}, ${idColumn}) > (${ts}::timestamptz, ${id}::uuid)`
    );
  }

  const orderByClause =
    sortOrder === "newest" ? [desc(sortColumn), desc(idColumn)] : [asc(sortColumn), asc(idColumn)];

  return {
    // Full-precision sort key for cursor encoding. The pool hands back
    // Postgres's raw microsecond string for timestamptz (see parseTimestamptz);
    // mapWith decodes it to a Temporal.Instant so the cursor never loses the
    // microseconds a JS Date would truncate — which corrupted keyset pagination
    // (#680, #683).
    //
    // Null-tolerant: the "archived" sort (Wallabag) orders by readChangedAt
    // WITHOUT the readChanged view's isNotNull filter, so a row can have a null
    // sort key. That path is offset-paginated and ignores nextCursor. For the
    // cursor-paginated sorts (published is NOT NULL; readChanged filters
    // non-null) the sort key is always present.
    sortTs: sql`${sortColumn}`.mapWith(parseTimestamptzOrNull),

    // visible_entries emits exactly one row per (user, entry), and so does a
    // join on one subscription's memberships, so no DISTINCT ON dedup is
    // needed and the (sortColumn, id) keyset cursor resumes cleanly over
    // unique rows.
    apply: <T extends PgSelect>(query: T) =>
      (single
        ? query.innerJoin(
            subscriptionEntries,
            and(
              eq(subscriptionEntries.subscriptionId, single),
              eq(subscriptionEntries.userId, visibleEntries.userId),
              eq(subscriptionEntries.entryId, visibleEntries.id)
            )
          )
        : query
      )
        .where(and(...conditions))
        .orderBy(...orderByClause)
        .limit(limit + 1)
        .offset(params.offset ?? 0),

    paginate: <R extends { id: string; sortTs: Temporal.Instant | null }>(
      rows: R[]
    ): { items: R[]; nextCursor?: string } => {
      if (rows.length <= limit) return { items: rows };
      const items = rows.slice(0, limit);
      const last = items[items.length - 1];
      // sortTs is only null for the offset-paginated "archived" sort (which
      // ignores nextCursor).
      return {
        items,
        nextCursor:
          last?.sortTs != null
            ? timelineCursor.encode({ ts: last.sortTs.toString(), id: last.id })
            : undefined,
      };
    },
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
