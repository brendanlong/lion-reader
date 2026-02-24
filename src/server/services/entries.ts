/**
 * Entries Service
 *
 * Business logic for entry operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, desc, asc, inArray, sql, isNull, lte } from "drizzle-orm";
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
  sortBy?: "published" | "readChanged" | "predictedScore"; // Which column to sort by (default: published)
  cursor?: string;
  limit?: number;
  maxLimit?: number; // Override MAX_LIMIT (e.g., for Google Reader API which needs larger batches)
  publishedAfter?: Date; // Only entries published/fetched after this timestamp
  publishedBefore?: Date; // Only entries published/fetched before this timestamp
  showSpam: boolean;
  // Best feed sorting weights: sort by scoreWeight * predicted_score + uncertaintyWeight * (1 - confidence)
  bestFeedScoreWeight?: number;
  bestFeedUncertaintyWeight?: number;
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
  score: number | null;
  implicitScore: number;
  predictedScore: number | null;
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
  score: number | null;
  implicitScore: number;
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

/**
 * Computes the implicit score from boolean signal flags and entry type.
 *
 * Priority: starred (+2) > unread (0) > read-on-list (-1) > saved default (+1) > default (0)
 *
 * Marking unread overrides read-on-list (returns 0 instead of -1) but doesn't
 * give a positive bonus. Saved articles default to +1 because the user explicitly
 * saved them, indicating interest.
 */
export function computeImplicitScore(
  hasStarred: boolean,
  hasMarkedUnread: boolean,
  hasMarkedReadOnList: boolean,
  type?: "web" | "email" | "saved"
): number {
  if (hasStarred) return 2;
  if (hasMarkedUnread) return 0;
  if (hasMarkedReadOnList) return -1;
  // Saved articles default to +1 since user explicitly saved them
  if (type === "saved") return 1;
  return 0;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * Sentinel value used for null predicted scores in sorting.
 * Pushes entries without predictions to the end of score-sorted lists.
 */
export const NULL_PREDICTED_SCORE_SENTINEL = -999;

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
  score: number | null;
  hasMarkedReadOnList: boolean;
  hasMarkedUnread: boolean;
  hasStarred: boolean;
  predictedScore: number | null;
}

/**
 * Maps a database row to an EntryListItem, computing implicit score.
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
    score: row.score,
    implicitScore: computeImplicitScore(
      row.hasStarred,
      row.hasMarkedUnread,
      row.hasMarkedReadOnList,
      row.type
    ),
    predictedScore: row.predictedScore,
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

function encodeCursor(ts: Date, entryId: string): string {
  const data: CursorData = { ts: ts.toISOString(), id: entryId };
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64");
}

/**
 * Cursor for score-based sorting where the sort value is a number, not a date.
 */
interface ScoreCursorData {
  score: string; // Stringified number for consistent serialization
  id: string;
}

function decodeScoreCursor(cursor: string): ScoreCursorData {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as ScoreCursorData;
    if (parsed.score === undefined || !parsed.id) {
      throw new Error("Invalid cursor structure");
    }
    return parsed;
  } catch {
    throw errors.validation("Invalid cursor format");
  }
}

function encodeScoreCursor(score: number, entryId: string): string {
  const data: ScoreCursorData = { score: String(score), id: entryId };
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

  // Timestamp filters (used by Google Reader API ot/nt parameters)
  if (params.publishedAfter) {
    conditions.push(
      sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt}) >= ${params.publishedAfter}`
    );
  }
  if (params.publishedBefore) {
    conditions.push(
      sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt}) <= ${params.publishedBefore}`
    );
  }

  // predictedScore sorting uses a different cursor and sort mechanism
  if (params.sortBy === "predictedScore") {
    // Sort by weighted formula: scoreWeight * predicted_score + uncertaintyWeight * (1 - confidence)
    // For entries without predictions, use a sentinel to push them to the end.
    const scoreWeight = params.bestFeedScoreWeight ?? 1;
    const uncertaintyWeight = params.bestFeedUncertaintyWeight ?? 1;
    const scoreColumn = sql`CASE WHEN ${visibleEntries.predictedScore} IS NOT NULL THEN ${scoreWeight} * ${visibleEntries.predictedScore} + ${uncertaintyWeight} * (1 - COALESCE(${visibleEntries.predictionConfidence}, 0)) ELSE ${NULL_PREDICTED_SCORE_SENTINEL}::real END`;

    // Cursor condition for score-based pagination
    if (params.cursor) {
      const { score: scoreStr, id } = decodeScoreCursor(params.cursor);
      const cursorScore = parseFloat(scoreStr);
      // Always descending for predicted score (highest first)
      conditions.push(
        sql`(${scoreColumn} < ${cursorScore} OR (${scoreColumn} = ${cursorScore} AND ${visibleEntries.id} < ${id}))`
      );
    }

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
        score: visibleEntries.score,
        hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
        hasMarkedUnread: visibleEntries.hasMarkedUnread,
        hasStarred: visibleEntries.hasStarred,
        readChangedAt: visibleEntries.readChangedAt,
        predictedScore: visibleEntries.predictedScore,
        predictionConfidence: visibleEntries.predictionConfidence,
        computedSortScore: sql<number>`${scoreColumn}`.as("computed_sort_score"),
      })
      .from(visibleEntries)
      .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
      .where(and(...conditions))
      .orderBy(desc(scoreColumn), desc(visibleEntries.id))
      .limit(limit + 1);

    const hasMore = queryResults.length > limit;
    const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;
    const items = resultEntries.map(toEntryListItem);

    let nextCursor: string | undefined;
    if (hasMore && resultEntries.length > 0) {
      const lastEntry = resultEntries[resultEntries.length - 1];
      nextCursor = encodeScoreCursor(lastEntry.computedSortScore, lastEntry.id);
    }

    return { items, nextCursor };
  }

  // Sort column - readChanged sorts by when read state was last changed
  const sortColumn =
    params.sortBy === "readChanged"
      ? visibleEntries.readChangedAt
      : sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt})`;

  // Cursor condition
  if (params.cursor) {
    const { ts, id } = decodeCursor(params.cursor);
    const cursorTs = new Date(ts);
    if (sortOrder === "newest") {
      conditions.push(
        sql`(${sortColumn} < ${cursorTs} OR (${sortColumn} = ${cursorTs} AND ${visibleEntries.id} < ${id}))`
      );
    } else {
      conditions.push(
        sql`(${sortColumn} > ${cursorTs} OR (${sortColumn} = ${cursorTs} AND ${visibleEntries.id} > ${id}))`
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
      score: visibleEntries.score,
      hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
      hasMarkedUnread: visibleEntries.hasMarkedUnread,
      hasStarred: visibleEntries.hasStarred,
      readChangedAt: visibleEntries.readChangedAt,
      predictedScore: visibleEntries.predictedScore,
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
    const lastTs =
      params.sortBy === "readChanged"
        ? lastEntry.readChangedAt
        : (lastEntry.publishedAt ?? lastEntry.fetchedAt);
    nextCursor = encodeCursor(lastTs, lastEntry.id);
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
    conditions.push(
      sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt}) >= ${params.publishedAfter}`
    );
  }
  if (params.publishedBefore) {
    conditions.push(
      sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt}) <= ${params.publishedBefore}`
    );
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
      score: visibleEntries.score,
      hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
      hasMarkedUnread: visibleEntries.hasMarkedUnread,
      hasStarred: visibleEntries.hasStarred,
      predictedScore: visibleEntries.predictedScore,
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
    nextCursor = encodeCursor(new Date(lastEntry.rank.toString()), lastEntry.id);
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
      score: visibleEntries.score,
      hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
      hasMarkedUnread: visibleEntries.hasMarkedUnread,
      hasStarred: visibleEntries.hasStarred,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId)))
    .limit(1);

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  const row = result[0];
  return {
    ...row,
    score: row.score,
    implicitScore: computeImplicitScore(
      row.hasStarred,
      row.hasMarkedUnread,
      row.hasMarkedReadOnList,
      row.type
    ),
  };
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
      score: visibleEntries.score,
      hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
      hasMarkedUnread: visibleEntries.hasMarkedUnread,
      hasStarred: visibleEntries.hasStarred,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(inArray(visibleEntries.id, entryIds), eq(visibleEntries.userId, userId)));

  // Build a map for O(1) lookup, then return in original order
  const resultMap = new Map<string, EntryFull>();
  for (const row of results) {
    resultMap.set(row.id, {
      ...row,
      score: row.score,
      implicitScore: computeImplicitScore(
        row.hasStarred,
        row.hasMarkedUnread,
        row.hasMarkedReadOnList,
        row.type
      ),
    });
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
        lte(userEntries.readChangedAt, changedAt)
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
): Promise<{ total: number; unread: number }> {
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
    return { total: 0, unread: 0 };
  }

  if (feedFilter.feedIdsCondition !== null) {
    conditions.push(inArray(visibleEntries.feedId, feedFilter.feedIdsCondition));
  }

  // Apply entry filter conditions (unreadOnly, starredOnly, type, excludeTypes, showSpam)
  conditions.push(...buildEntryFilterConditions(params));

  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
      unread: sql<number>`count(*) FILTER (WHERE ${visibleEntries.read} = false)::int`,
    })
    .from(visibleEntries)
    .where(and(...conditions));

  return {
    total: result[0]?.total ?? 0,
    unread: result[0]?.unread ?? 0,
  };
}

/**
 * Score state returned from score mutations.
 */
export interface ScoreState {
  id: string;
  read: boolean;
  starred: boolean;
  updatedAt: Date;
  score: number | null;
  implicitScore: number;
}

/**
 * Sets the explicit score for an entry.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * score_changed_at timestamp (or if score has never been set).
 *
 * @param score - The score to set (-2 to +2), or null to clear explicit vote
 * @param changedAt - When the user initiated the action. Defaults to now.
 */
export async function setEntryScore(
  db: typeof dbType,
  userId: string,
  entryId: string,
  score: number | null,
  changedAt: Date = new Date()
): Promise<ScoreState> {
  // Conditional update: only apply if incoming timestamp is newer or score never set
  await db
    .update(userEntries)
    .set({
      score,
      scoreChangedAt: changedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(userEntries.userId, userId),
        eq(userEntries.entryId, entryId),
        sql`(${userEntries.scoreChangedAt} IS NULL OR ${userEntries.scoreChangedAt} <= ${changedAt})`
      )
    );

  // Always return final state (join with entries to get type for implicit score)
  const result = await db
    .select({
      id: userEntries.entryId,
      read: userEntries.read,
      starred: userEntries.starred,
      updatedAt: userEntries.updatedAt,
      score: userEntries.score,
      hasMarkedReadOnList: userEntries.hasMarkedReadOnList,
      hasMarkedUnread: userEntries.hasMarkedUnread,
      hasStarred: userEntries.hasStarred,
      type: entries.type,
    })
    .from(userEntries)
    .innerJoin(entries, eq(userEntries.entryId, entries.id))
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  const row = result[0];
  return {
    id: row.id,
    read: row.read,
    starred: row.starred,
    updatedAt: row.updatedAt,
    score: row.score,
    implicitScore: computeImplicitScore(
      row.hasStarred,
      row.hasMarkedUnread,
      row.hasMarkedReadOnList,
      row.type
    ),
  };
}
