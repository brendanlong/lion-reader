/**
 * Entries Service
 *
 * Business logic for entry operations. Used by both tRPC routers and MCP server.
 */

import {
  eq,
  and,
  desc,
  asc,
  inArray,
  sql,
  isNull,
  isNotNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  entries,
  feeds,
  subscriptionFeeds,
  userEntries,
  subscriptions,
  subscriptionTags,
  visibleEntries,
} from "@/server/db/schema";
import { errors } from "@/server/trpc/errors";
import { buildEntryFeedFilter, buildEntryFilterConditions } from "./entry-filters";

// ============================================================================
// Types
// ============================================================================

export interface ListEntriesParams {
  userId: string;
  query?: string; // Optional full-text search query (searches title and content)
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  type?: "web" | "email" | "saved";
  excludeTypes?: Array<"web" | "email" | "saved">;
  unreadOnly?: boolean;
  readOnly?: boolean;
  starredOnly?: boolean;
  unstarredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
  sortBy?: "published" | "readChanged"; // Which column to sort by (default: published)
  cursor?: string;
  limit?: number;
  maxLimit?: number; // Override MAX_LIMIT (e.g., for Google Reader API which needs larger batches)
  publishedAfter?: Date; // Only entries published/fetched after this timestamp
  publishedBefore?: Date; // Only entries published/fetched before this timestamp
  showSpam: boolean;
}

export interface SearchEntriesParams {
  userId: string;
  query: string;
  searchIn?: "title" | "content" | "both";
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  type?: "web" | "email" | "saved";
  excludeTypes?: Array<"web" | "email" | "saved">;
  unreadOnly?: boolean;
  readOnly?: boolean;
  starredOnly?: boolean;
  unstarredOnly?: boolean;
  cursor?: string;
  limit?: number;
  maxLimit?: number;
  publishedAfter?: Date;
  publishedBefore?: Date;
  showSpam: boolean;
}

export interface EntryListItem {
  id: string;
  subscriptionId: string | null;
  feedId: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  updatedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  siteName: string | null;
}

export interface EntryFull {
  id: string;
  subscriptionId: string | null;
  feedId: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  author: string | null;
  contentOriginal: string | null;
  contentCleaned: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  updatedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  feedUrl: string | null;
  siteName: string | null;
  unsubscribeUrl: string | null;
}

export interface EntryState {
  id: string;
  read: boolean;
  starred: boolean;
}

export interface SubscriptionUnreadCount {
  subscriptionId: string;
  unreadCount: number;
}

export interface TagUnreadCount {
  tagId: string;
  unreadCount: number;
}

export interface MarkReadResult {
  entries: EntryState[];
  subscriptionUnreadCounts: SubscriptionUnreadCount[];
  tagUnreadCounts: TagUnreadCount[];
}

// ============================================================================
// Helpers
// ============================================================================

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// ============================================================================
// Row Mapping Helper
// ============================================================================

/**
 * Shape of a database row from the entry list query (shared across list/search).
 */
interface EntryListRow {
  id: string;
  subscriptionId: string | null;
  feedId: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  updatedAt: Date;
  read: boolean;
  starred: boolean;
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
    feedId: row.feedId,
    type: row.type,
    url: row.url,
    title: row.title,
    author: row.author,
    summary: row.summary,
    publishedAt: row.publishedAt,
    fetchedAt: row.fetchedAt,
    read: row.read,
    starred: row.starred,
    updatedAt: row.updatedAt,
    feedTitle: row.feedTitle,
    siteName: row.siteName,
  };
}

// ============================================================================
// Cursor Helpers
// ============================================================================

interface CursorData {
  ts: string;
  id: string;
}

function decodeCursor(cursor: string): CursorData {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as CursorData;
    if (!parsed.ts || !parsed.id) {
      throw new Error("Invalid cursor structure");
    }
    return parsed;
  } catch {
    throw errors.validation("Invalid cursor format");
  }
}

function encodeCursor(ts: string, entryId: string): string {
  const data: CursorData = { ts, id: entryId };
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64");
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
  // If query is provided, delegate to search implementation
  if (params.query) {
    return searchEntries(db, {
      ...params,
      query: params.query,
      searchIn: "both", // Always search both title and content
      showSpam: params.showSpam,
    });
  }

  const effectiveMaxLimit = params.maxLimit ?? MAX_LIMIT;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, effectiveMaxLimit);
  const sortOrder = params.sortOrder ?? "newest";

  const conditions = [eq(visibleEntries.userId, params.userId)];

  // Apply feed filters (subscriptionId, tagId, uncategorized)
  const feedFilter = await buildEntryFeedFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    params.userId
  );

  if (feedFilter.isEmpty) {
    return { items: [], nextCursor: undefined };
  }

  if (feedFilter.feedIdsCondition !== null) {
    conditions.push(inArray(visibleEntries.feedId, feedFilter.feedIdsCondition));
  }

  // Apply entry filter conditions (unreadOnly, starredOnly, type, excludeTypes, showSpam)
  conditions.push(...buildEntryFilterConditions(params));

  // Timestamp filters (used by Google Reader API ot/nt parameters).
  // publishedOrFetchedAt is the denormalized COALESCE(publishedAt, fetchedAt).
  if (params.publishedAfter) {
    conditions.push(sql`${visibleEntries.publishedOrFetchedAt} >= ${params.publishedAfter}`);
  }
  if (params.publishedBefore) {
    conditions.push(sql`${visibleEntries.publishedOrFetchedAt} <= ${params.publishedBefore}`);
  }

  // Recently Read: exclude entries that were never explicitly read-state-changed
  if (params.sortBy === "readChanged") {
    conditions.push(isNotNull(visibleEntries.readChangedAt));
  }

  // Sort column - readChanged sorts by when read state was last changed.
  // The default "published" sort uses the denormalized user_entries sort key so the
  // planner can serve filter + sort from idx_user_entries_published_or_fetched.
  const sortColumn =
    params.sortBy === "readChanged"
      ? visibleEntries.readChangedAt
      : visibleEntries.publishedOrFetchedAt;

  // Raw ISO string version of sortColumn with microsecond precision.
  // Used for cursor encoding to avoid JavaScript Date truncation.
  const sortTsRawExpr =
    params.sortBy === "readChanged"
      ? sql<string>`to_char(${visibleEntries.readChangedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
      : sql<string>`to_char(${visibleEntries.publishedOrFetchedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

  // Cursor condition
  // Pass timestamp string directly to Postgres (::timestamptz) to preserve
  // microsecond precision. Using new Date(ts) would truncate to milliseconds,
  // causing entries to fall into gaps between cursor and actual timestamps.
  if (params.cursor) {
    const { ts, id } = decodeCursor(params.cursor);
    if (sortOrder === "newest") {
      conditions.push(
        sql`(${sortColumn} < ${ts}::timestamptz OR (${sortColumn} = ${ts}::timestamptz AND ${visibleEntries.id} < ${id}))`
      );
    } else {
      conditions.push(
        sql`(${sortColumn} > ${ts}::timestamptz OR (${sortColumn} = ${ts}::timestamptz AND ${visibleEntries.id} > ${id}))`
      );
    }
  }

  // Query
  const orderByClause =
    sortOrder === "newest"
      ? [desc(sortColumn), desc(visibleEntries.id)]
      : [asc(sortColumn), asc(visibleEntries.id)];

  const queryResults = await db
    .select({
      id: visibleEntries.id,
      feedId: visibleEntries.feedId,
      type: visibleEntries.type,
      url: visibleEntries.url,
      title: visibleEntries.title,
      author: visibleEntries.author,
      summary: visibleEntries.summary,
      publishedAt: visibleEntries.publishedAt,
      fetchedAt: visibleEntries.fetchedAt,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      updatedAt: visibleEntries.updatedAt,
      subscriptionId: visibleEntries.subscriptionId,
      siteName: visibleEntries.siteName,
      feedTitle: feeds.title,
      readChangedAt: visibleEntries.readChangedAt,
      sortTsRaw: sortTsRawExpr,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(...conditions))
    .orderBy(...orderByClause)
    .limit(limit + 1);

  const hasMore = queryResults.length > limit;
  const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;
  const items = resultEntries.map(toEntryListItem);

  let nextCursor: string | undefined;
  if (hasMore && resultEntries.length > 0) {
    const lastEntry = resultEntries[resultEntries.length - 1];
    nextCursor = encodeCursor(lastEntry.sortTsRaw, lastEntry.id);
  }

  return { items, nextCursor };
}

/**
 * Searches entries by title and/or content.
 */
async function searchEntries(
  db: typeof dbType,
  params: SearchEntriesParams
): Promise<{ items: EntryListItem[]; nextCursor?: string }> {
  const effectiveMaxLimit = params.maxLimit ?? MAX_LIMIT;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, effectiveMaxLimit);
  const searchIn = params.searchIn ?? "both";

  const conditions = [eq(visibleEntries.userId, params.userId)];

  // Build full-text search vector
  let searchVector: ReturnType<typeof sql>;
  if (searchIn === "title") {
    searchVector = sql`to_tsvector('english', COALESCE(${visibleEntries.title}, ''))`;
  } else if (searchIn === "content") {
    searchVector = sql`to_tsvector('english', COALESCE(${visibleEntries.contentCleaned}, ''))`;
  } else {
    searchVector = sql`to_tsvector('english', COALESCE(${visibleEntries.title}, '') || ' ' || COALESCE(${visibleEntries.contentCleaned}, ''))`;
  }

  const searchQuery = sql`plainto_tsquery('english', ${params.query})`;
  conditions.push(sql`${searchVector} @@ ${searchQuery}`);

  const rankColumn = sql<number>`ts_rank(${searchVector}, ${searchQuery})`;

  // Apply feed filters (subscriptionId, tagId, uncategorized)
  const feedFilter = await buildEntryFeedFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    params.userId
  );

  if (feedFilter.isEmpty) {
    return { items: [], nextCursor: undefined };
  }

  if (feedFilter.feedIdsCondition !== null) {
    conditions.push(inArray(visibleEntries.feedId, feedFilter.feedIdsCondition));
  }

  // Apply entry filter conditions (unreadOnly, starredOnly, type, excludeTypes, showSpam)
  conditions.push(...buildEntryFilterConditions(params));

  // Timestamp filters
  if (params.publishedAfter) {
    conditions.push(sql`${visibleEntries.publishedOrFetchedAt} >= ${params.publishedAfter}`);
  }
  if (params.publishedBefore) {
    conditions.push(sql`${visibleEntries.publishedOrFetchedAt} <= ${params.publishedBefore}`);
  }

  // Cursor for search results (based on rank)
  if (params.cursor) {
    const { ts: rankStr, id } = decodeCursor(params.cursor);
    const cursorRank = parseFloat(rankStr);
    conditions.push(
      sql`(${rankColumn} < ${cursorRank} OR (${rankColumn} = ${cursorRank} AND ${visibleEntries.id} < ${id}))`
    );
  }

  // Query
  const queryResults = await db
    .select({
      id: visibleEntries.id,
      feedId: visibleEntries.feedId,
      type: visibleEntries.type,
      url: visibleEntries.url,
      title: visibleEntries.title,
      author: visibleEntries.author,
      summary: visibleEntries.summary,
      publishedAt: visibleEntries.publishedAt,
      fetchedAt: visibleEntries.fetchedAt,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      updatedAt: visibleEntries.updatedAt,
      subscriptionId: visibleEntries.subscriptionId,
      siteName: visibleEntries.siteName,
      feedTitle: feeds.title,
      rank: rankColumn,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(...conditions))
    .orderBy(desc(rankColumn), desc(visibleEntries.id))
    .limit(limit + 1);

  const hasMore = queryResults.length > limit;
  const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;
  const items = resultEntries.map(toEntryListItem);

  let nextCursor: string | undefined;
  if (hasMore && resultEntries.length > 0) {
    const lastEntry = resultEntries[resultEntries.length - 1];
    nextCursor = encodeCursor(lastEntry.rank.toString(), lastEntry.id);
  }

  return { items, nextCursor };
}

/**
 * Gets a single entry by ID with full content.
 */
export async function getEntry(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<EntryFull> {
  const result = await db
    .select({
      id: visibleEntries.id,
      feedId: visibleEntries.feedId,
      type: visibleEntries.type,
      url: visibleEntries.url,
      title: visibleEntries.title,
      author: visibleEntries.author,
      contentOriginal: visibleEntries.contentOriginal,
      contentCleaned: visibleEntries.contentCleaned,
      summary: visibleEntries.summary,
      publishedAt: visibleEntries.publishedAt,
      fetchedAt: visibleEntries.fetchedAt,
      updatedAt: visibleEntries.updatedAt,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      subscriptionId: visibleEntries.subscriptionId,
      siteName: visibleEntries.siteName,
      feedTitle: feeds.title,
      feedUrl: feeds.url,
      unsubscribeUrl: visibleEntries.unsubscribeUrl,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId)))
    .limit(1);

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  return result[0];
}

/**
 * Gets multiple entries by ID in a single query.
 * Returns entries in the same order as the input IDs.
 * Missing entries are silently skipped.
 */
export async function getEntries(
  db: typeof dbType,
  userId: string,
  entryIds: string[]
): Promise<EntryFull[]> {
  if (entryIds.length === 0) return [];

  const results = await db
    .select({
      id: visibleEntries.id,
      feedId: visibleEntries.feedId,
      type: visibleEntries.type,
      url: visibleEntries.url,
      title: visibleEntries.title,
      author: visibleEntries.author,
      contentOriginal: visibleEntries.contentOriginal,
      contentCleaned: visibleEntries.contentCleaned,
      summary: visibleEntries.summary,
      publishedAt: visibleEntries.publishedAt,
      fetchedAt: visibleEntries.fetchedAt,
      updatedAt: visibleEntries.updatedAt,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      subscriptionId: visibleEntries.subscriptionId,
      siteName: visibleEntries.siteName,
      feedTitle: feeds.title,
      feedUrl: feeds.url,
      unsubscribeUrl: visibleEntries.unsubscribeUrl,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(inArray(visibleEntries.id, entryIds), eq(visibleEntries.userId, userId)));

  // Build a map for O(1) lookup, then return in original order
  const resultMap = new Map<string, EntryFull>();
  for (const row of results) {
    resultMap.set(row.id, row);
  }

  return entryIds.map((id) => resultMap.get(id)).filter((e): e is EntryFull => e != null);
}

/**
 * Marks entries as read or unread.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * read_changed_at timestamp. This prevents stale updates from overwriting newer state.
 *
 * @param changedAt - When the user initiated the action. Defaults to now.
 */
export async function markEntriesRead(
  db: typeof dbType,
  userId: string,
  entryIds: string[],
  read: boolean,
  changedAt: Date = new Date()
): Promise<MarkReadResult> {
  if (entryIds.length === 0) {
    return { entries: [], subscriptionUnreadCounts: [], tagUnreadCounts: [] };
  }

  if (entryIds.length > 1000) {
    throw errors.validation("Maximum 1000 entries per request");
  }

  // Conditional update: only apply if incoming timestamp is newer or equal
  await db
    .update(userEntries)
    .set({
      read,
      readChangedAt: changedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userEntries.userId, userId),
        inArray(userEntries.entryId, entryIds),
        or(isNull(userEntries.readChangedAt), lte(userEntries.readChangedAt, changedAt))
      )
    );

  // Always return final state for all requested entries
  const finalEntries = await db
    .select({
      id: userEntries.entryId,
      read: userEntries.read,
      starred: userEntries.starred,
    })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, entryIds)));

  // Get affected feed IDs
  const affectedFeedsSubquery = db
    .selectDistinct({ feedId: entries.feedId })
    .from(entries)
    .where(inArray(entries.id, entryIds))
    .as("affected_feeds");

  // Find subscriptions containing the affected feeds via subscription_feeds junction table
  const affectedSubscriptionsSubquery = db
    .selectDistinct({ subscriptionId: subscriptions.id })
    .from(subscriptions)
    .innerJoin(subscriptionFeeds, eq(subscriptionFeeds.subscriptionId, subscriptions.id))
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        inArray(subscriptionFeeds.feedId, sql`(SELECT feed_id FROM ${affectedFeedsSubquery})`)
      )
    )
    .as("affected_subscriptions");

  const subscriptionUnreadCounts = await db
    .select({
      subscriptionId: affectedSubscriptionsSubquery.subscriptionId,
      unreadCount: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${userEntries.read} = false), 0)::int`,
    })
    .from(affectedSubscriptionsSubquery)
    .leftJoin(
      subscriptionFeeds,
      eq(subscriptionFeeds.subscriptionId, affectedSubscriptionsSubquery.subscriptionId)
    )
    .leftJoin(entries, eq(entries.feedId, subscriptionFeeds.feedId))
    .leftJoin(userEntries, and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId)))
    .groupBy(affectedSubscriptionsSubquery.subscriptionId);

  // Get tag unread counts for tags associated with affected subscriptions
  const affectedTagsSubquery = db
    .selectDistinct({ tagId: subscriptionTags.tagId })
    .from(subscriptionTags)
    .where(
      inArray(
        subscriptionTags.subscriptionId,
        sql`(SELECT subscription_id FROM ${affectedSubscriptionsSubquery})`
      )
    )
    .as("affected_tags");

  const tagUnreadCounts = await db
    .select({
      tagId: affectedTagsSubquery.tagId,
      unreadCount: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${userEntries.read} = false), 0)::int`,
    })
    .from(affectedTagsSubquery)
    .leftJoin(subscriptionTags, eq(subscriptionTags.tagId, affectedTagsSubquery.tagId))
    .leftJoin(
      subscriptions,
      and(
        eq(subscriptionTags.subscriptionId, subscriptions.id),
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt)
      )
    )
    .leftJoin(subscriptionFeeds, eq(subscriptionFeeds.subscriptionId, subscriptions.id))
    .leftJoin(entries, eq(entries.feedId, subscriptionFeeds.feedId))
    .leftJoin(userEntries, and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId)))
    .groupBy(affectedTagsSubquery.tagId);

  return { entries: finalEntries, subscriptionUnreadCounts, tagUnreadCounts };
}

/**
 * Marks all unread entries matching the given filters as read.
 *
 * Shared implementation used by both the tRPC markAllRead mutation and the
 * Google Reader API mark-all-as-read endpoint.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * read_changed_at timestamp (or if read_changed_at is NULL).
 *
 * @returns The entry IDs that were marked as read.
 */
export async function markAllEntriesRead(
  db: typeof dbType,
  params: {
    userId: string;
    feedIds?: string[];
    subscriptionId?: string;
    tagId?: string;
    uncategorized?: boolean;
    starredOnly?: boolean;
    type?: "web" | "email" | "saved";
    before?: Date;
    changedAt?: Date;
  }
): Promise<string[]> {
  const changedAt = params.changedAt ?? new Date();

  const conditions: SQL[] = [
    eq(userEntries.userId, params.userId),
    eq(userEntries.read, false),
    or(isNull(userEntries.readChangedAt), lte(userEntries.readChangedAt, changedAt))!,
  ];

  // Filter by explicit feed IDs (used by GReader route after stream resolution)
  if (params.feedIds) {
    const entryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .where(inArray(entries.feedId, params.feedIds));

    conditions.push(inArray(userEntries.entryId, entryIdsSubquery));
  }

  // Filter by subscriptionId (single subquery, no extra roundtrip)
  if (params.subscriptionId) {
    const entryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .where(
        inArray(
          entries.feedId,
          db
            .select({ feedId: subscriptionFeeds.feedId })
            .from(subscriptionFeeds)
            .innerJoin(
              subscriptions,
              and(
                eq(subscriptions.id, subscriptionFeeds.subscriptionId),
                eq(subscriptions.userId, params.userId),
                isNull(subscriptions.unsubscribedAt)
              )
            )
            .where(eq(subscriptionFeeds.subscriptionId, params.subscriptionId))
        )
      );

    conditions.push(inArray(userEntries.entryId, entryIdsSubquery));
  }

  // Filter by tag (scoped to user via subscription_tags → subscription_feeds)
  if (params.tagId) {
    const taggedFeedIdsSubquery = db
      .select({ feedId: subscriptionFeeds.feedId })
      .from(subscriptionTags)
      .innerJoin(
        subscriptionFeeds,
        eq(subscriptionTags.subscriptionId, subscriptionFeeds.subscriptionId)
      )
      .where(eq(subscriptionTags.tagId, params.tagId));

    const taggedEntryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .where(inArray(entries.feedId, taggedFeedIdsSubquery));

    conditions.push(inArray(userEntries.entryId, taggedEntryIdsSubquery));
  }

  // Filter by uncategorized (no tags) - use LEFT JOIN anti-join to avoid scanning all subscription_tags
  if (params.uncategorized) {
    const uncategorizedFeedIdsSubquery = db
      .select({ feedId: subscriptionFeeds.feedId })
      .from(subscriptions)
      .innerJoin(subscriptionFeeds, eq(subscriptionFeeds.subscriptionId, subscriptions.id))
      .leftJoin(subscriptionTags, eq(subscriptionTags.subscriptionId, subscriptions.id))
      .where(
        and(
          eq(subscriptions.userId, params.userId),
          isNull(subscriptions.unsubscribedAt),
          isNull(subscriptionTags.subscriptionId)
        )
      );

    const uncategorizedEntryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .where(inArray(entries.feedId, uncategorizedFeedIdsSubquery));

    conditions.push(inArray(userEntries.entryId, uncategorizedEntryIdsSubquery));
  }

  // Filter by starred only
  if (params.starredOnly) {
    conditions.push(eq(userEntries.starred, true));
  }

  // Filter by feed type
  if (params.type) {
    const typeEntryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .innerJoin(feeds, eq(entries.feedId, feeds.id))
      .where(eq(feeds.type, params.type));

    conditions.push(inArray(userEntries.entryId, typeEntryIdsSubquery));
  }

  // Filter by before date
  if (params.before) {
    const beforeEntryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .where(lte(entries.fetchedAt, params.before));

    conditions.push(inArray(userEntries.entryId, beforeEntryIdsSubquery));
  }

  const result = await db
    .update(userEntries)
    .set({
      read: true,
      readChangedAt: changedAt,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning({ entryId: userEntries.entryId });

  return result.map((r) => r.entryId);
}

/**
 * Stars or unstars an entry.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * starred_changed_at timestamp. This prevents stale updates from overwriting newer state.
 *
 * @param changedAt - When the user initiated the action. Defaults to now.
 */
export async function updateEntryStarred(
  db: typeof dbType,
  userId: string,
  entryId: string,
  starred: boolean,
  changedAt: Date = new Date()
): Promise<EntryState> {
  // Conditional update: only apply if incoming timestamp is newer or equal
  await db
    .update(userEntries)
    .set({
      starred,
      starredChangedAt: changedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userEntries.userId, userId),
        eq(userEntries.entryId, entryId),
        lte(userEntries.starredChangedAt, changedAt)
      )
    );

  // Always return final state
  const result = await db
    .select({
      id: userEntries.entryId,
      read: userEntries.read,
      starred: userEntries.starred,
    })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  return result[0];
}

/**
 * Counts entries with filters.
 */
export async function countEntries(
  db: typeof dbType,
  userId: string,
  params: {
    subscriptionId?: string;
    tagId?: string;
    uncategorized?: boolean;
    type?: "web" | "email" | "saved";
    excludeTypes?: Array<"web" | "email" | "saved">;
    unreadOnly?: boolean;
    readOnly?: boolean;
    starredOnly?: boolean;
    unstarredOnly?: boolean;
    showSpam: boolean;
  }
): Promise<{ unread: number }> {
  const conditions = [eq(visibleEntries.userId, userId)];

  // Apply feed filters (subscriptionId, tagId, uncategorized)
  const feedFilter = await buildEntryFeedFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    userId
  );

  if (feedFilter.isEmpty) {
    return { unread: 0 };
  }

  if (feedFilter.feedIdsCondition !== null) {
    conditions.push(inArray(visibleEntries.feedId, feedFilter.feedIdsCondition));
  }

  // Apply entry filter conditions (unreadOnly, starredOnly, type, excludeTypes, showSpam)
  conditions.push(...buildEntryFilterConditions(params));

  const result = await db
    .select({
      unread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.read} = false)::int`,
    })
    .from(visibleEntries)
    .where(and(...conditions));

  return {
    unread: result[0]?.unread ?? 0,
  };
}

/**
 * Counts total entries matching filters. Used only by APIs that need total
 * counts for pagination metadata (e.g., Wallabag compatibility API).
 *
 * Most callers should use `countEntries` instead, which only counts unread
 * entries and can leverage partial indexes for better performance.
 */
export async function countTotalEntries(
  db: typeof dbType,
  userId: string,
  params: {
    subscriptionId?: string;
    tagId?: string;
    uncategorized?: boolean;
    type?: "web" | "email" | "saved";
    excludeTypes?: Array<"web" | "email" | "saved">;
    unreadOnly?: boolean;
    readOnly?: boolean;
    starredOnly?: boolean;
    unstarredOnly?: boolean;
    showSpam: boolean;
  }
): Promise<number> {
  const conditions = [eq(visibleEntries.userId, userId)];

  const feedFilter = await buildEntryFeedFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    userId
  );

  if (feedFilter.isEmpty) {
    return 0;
  }

  if (feedFilter.feedIdsCondition !== null) {
    conditions.push(inArray(visibleEntries.feedId, feedFilter.feedIdsCondition));
  }

  conditions.push(...buildEntryFilterConditions(params));

  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(visibleEntries)
    .where(and(...conditions));

  return result[0]?.total ?? 0;
}
