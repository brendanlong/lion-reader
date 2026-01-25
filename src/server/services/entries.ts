/**
 * Entries Service
 *
 * Business logic for entry operations. Used by both tRPC routers and MCP server.
 */

import { eq, and, desc, asc, inArray, notInArray, sql, isNull, lte } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import {
  entries,
  feeds,
  userEntries,
  subscriptions,
  subscriptionTags,
  visibleEntries,
} from "@/server/db/schema";
import { errors } from "@/server/trpc/errors";
import { buildEntryFeedFilter } from "./entry-filters";

// ============================================================================
// Types
// ============================================================================

export interface ListEntriesParams {
  userId: string;
  subscriptionId?: string;
  tagId?: string;
  uncategorized?: boolean;
  type?: "web" | "email" | "saved";
  excludeTypes?: Array<"web" | "email" | "saved">;
  unreadOnly?: boolean;
  starredOnly?: boolean;
  sortOrder?: "newest" | "oldest";
  cursor?: string;
  limit?: number;
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
  starredOnly?: boolean;
  cursor?: string;
  limit?: number;
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
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
  feedUrl: string | null;
  siteName: string | null;
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
// Constants
// ============================================================================

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

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

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Lists entries with filters and pagination.
 */
export async function listEntries(
  db: typeof dbType,
  params: ListEntriesParams
): Promise<{ items: EntryListItem[]; nextCursor?: string }> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
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

  // Apply filters
  if (params.unreadOnly) {
    conditions.push(eq(visibleEntries.read, false));
  }

  if (params.starredOnly) {
    conditions.push(eq(visibleEntries.starred, true));
  }

  if (params.type) {
    conditions.push(eq(visibleEntries.type, params.type));
  }

  if (params.excludeTypes && params.excludeTypes.length > 0) {
    conditions.push(notInArray(visibleEntries.type, params.excludeTypes));
  }

  // Spam filter
  if (!params.showSpam) {
    conditions.push(eq(visibleEntries.isSpam, false));
  }

  // Sort column
  const sortColumn = sql`COALESCE(${visibleEntries.publishedAt}, ${visibleEntries.fetchedAt})`;

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
      subscriptionId: visibleEntries.subscriptionId,
      siteName: visibleEntries.siteName,
      feedTitle: feeds.title,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(...conditions))
    .orderBy(...orderByClause)
    .limit(limit + 1);

  const hasMore = queryResults.length > limit;
  const resultEntries = hasMore ? queryResults.slice(0, limit) : queryResults;

  const items = resultEntries.map((row) => ({
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
    feedTitle: row.feedTitle,
    siteName: row.siteName,
  }));

  let nextCursor: string | undefined;
  if (hasMore && resultEntries.length > 0) {
    const lastEntry = resultEntries[resultEntries.length - 1];
    const lastTs = lastEntry.publishedAt ?? lastEntry.fetchedAt;
    nextCursor = encodeCursor(lastTs, lastEntry.id);
  }

  return { items, nextCursor };
}

/**
 * Searches entries by title and/or content.
 */
export async function searchEntries(
  db: typeof dbType,
  params: SearchEntriesParams
): Promise<{ items: EntryListItem[]; nextCursor?: string }> {
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
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

  if (params.unreadOnly) {
    conditions.push(eq(visibleEntries.read, false));
  }

  if (params.starredOnly) {
    conditions.push(eq(visibleEntries.starred, true));
  }

  if (params.type) {
    conditions.push(eq(visibleEntries.type, params.type));
  }

  if (params.excludeTypes && params.excludeTypes.length > 0) {
    conditions.push(notInArray(visibleEntries.type, params.excludeTypes));
  }

  if (!params.showSpam) {
    conditions.push(eq(visibleEntries.isSpam, false));
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

  const items = resultEntries.map((row) => ({
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
    feedTitle: row.feedTitle,
    siteName: row.siteName,
  }));

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
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      subscriptionId: visibleEntries.subscriptionId,
      siteName: visibleEntries.siteName,
      feedTitle: feeds.title,
      feedUrl: feeds.url,
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

  // Find subscriptions containing the affected feeds
  const affectedSubscriptionsSubquery = db
    .selectDistinct({ subscriptionId: subscriptions.id })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        sql`${subscriptions.feedIds} && ARRAY(SELECT feed_id FROM ${affectedFeedsSubquery})`
      )
    )
    .as("affected_subscriptions");

  const subscriptionUnreadCounts = await db
    .select({
      subscriptionId: affectedSubscriptionsSubquery.subscriptionId,
      unreadCount: sql<number>`COALESCE(COUNT(*) FILTER (WHERE ${userEntries.read} = false), 0)::int`,
    })
    .from(affectedSubscriptionsSubquery)
    .leftJoin(subscriptions, eq(subscriptions.id, affectedSubscriptionsSubquery.subscriptionId))
    .leftJoin(entries, sql`${entries.feedId} = ANY(${subscriptions.feedIds})`)
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
    .leftJoin(entries, sql`${entries.feedId} = ANY(${subscriptions.feedIds})`)
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
    starredOnly?: boolean;
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

  if (params.unreadOnly) {
    conditions.push(eq(visibleEntries.read, false));
  }

  if (params.starredOnly) {
    conditions.push(eq(visibleEntries.starred, true));
  }

  if (params.type) {
    conditions.push(eq(visibleEntries.type, params.type));
  }

  if (params.excludeTypes && params.excludeTypes.length > 0) {
    conditions.push(notInArray(visibleEntries.type, params.excludeTypes));
  }

  if (!params.showSpam) {
    conditions.push(eq(visibleEntries.isSpam, false));
  }

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
