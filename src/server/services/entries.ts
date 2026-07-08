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
import { SANITIZER_VERSION } from "@/server/html/sanitize";
import { sanitizeEntryHtmlInWorker } from "@/server/worker-thread/pool";
import { logger } from "@/lib/logger";
import { errors } from "@/server/trpc/errors";
import { publishMarkAllRead } from "@/server/redis/pubsub";
import {
  getBulkEntryRelatedCounts,
  getEntryRelatedCounts,
  type BulkUnreadCounts,
  type UnreadCounts,
} from "./counts";
import { publishMarkReadStateChanges, publishStarredStateChange } from "./entry-events";
import { persistResanitizedFamily } from "./resanitize";
import {
  buildEntryFeedFilter,
  buildEntryFilterConditions,
  buildTaggedFeedIdsSubquery,
} from "./entry-filters";

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

/**
 * Full entry with content. `contentOriginal`/`contentCleaned` are the
 * sanitized versions of the stored content — raw feed HTML never leaves the
 * service layer.
 */
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
  updatedAt: Date;
}

/**
 * A single entry to mark read/unread, with an optional per-entry timestamp for
 * offline sync scenarios where entries were marked at different times.
 */
export interface MarkReadEntry {
  id: string;
  changedAt?: Date;
}

/**
 * Final entry state returned after marking read, including the context fields
 * needed for cache updates, count queries, and SSE publishing.
 */
export interface MarkReadEntryState {
  id: string;
  subscriptionId: string | null;
  read: boolean;
  starred: boolean;
  type: "web" | "email" | "saved";
  updatedAt: Date;
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
    // Node's "base64" decoder accepts both the standard (+/=) and URL-safe
    // (-_) alphabets, so this still decodes cursors we emitted before switching
    // encodeCursor to base64url, as well as any the client mangled by not
    // URL-encoding the standard form (e.g. "+" arriving as a space).
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
  // base64url (no "+", "/", or "=" padding) so the cursor is safe to place in a
  // URL query string. It is surfaced as the Google Reader `continuation` token,
  // and some clients (e.g. Read You) concatenate query params without
  // URL-encoding — a "+" in standard base64 would decode to a space server-side
  // and corrupt the cursor, 400ing every page past the first and aborting sync.
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

// ============================================================================
// Sanitized Content Resolution
// ============================================================================

/**
 * Base select fields shared by every full-entry read (getEntry/getEntries and
 * selectFullEntry). Selects the persisted sanitized content columns (plus
 * their versions) so raw untrusted HTML never leaves the service layer.
 */
const entryFullSelectFields = {
  id: visibleEntries.id,
  feedId: visibleEntries.feedId,
  type: visibleEntries.type,
  url: visibleEntries.url,
  title: visibleEntries.title,
  author: visibleEntries.author,
  // Sanitized content is served to the client; the matching version columns let
  // the read path detect when the allow-list changed and re-sanitize from raw.
  contentOriginalSanitized: visibleEntries.contentOriginalSanitized,
  contentCleanedSanitized: visibleEntries.contentCleanedSanitized,
  contentSanitizedVersion: visibleEntries.contentSanitizedVersion,
  summary: visibleEntries.summary,
  publishedAt: visibleEntries.publishedAt,
  fetchedAt: visibleEntries.fetchedAt,
  read: visibleEntries.read,
  starred: visibleEntries.starred,
  updatedAt: visibleEntries.updatedAt,
  subscriptionId: visibleEntries.subscriptionId,
  siteName: visibleEntries.siteName,
  feedTitle: feeds.title,
  feedUrl: feeds.url,
  unsubscribeUrl: visibleEntries.unsubscribeUrl,
};

/**
 * Superset selected by `selectFullEntry` for the tRPC full-entry view: adds
 * the full-content family, score-signal flags, and the subscription's
 * fetchFullContent setting.
 */
const fullEntrySelectFields = {
  ...entryFullSelectFields,
  fullContentOriginalSanitized: visibleEntries.fullContentOriginalSanitized,
  fullContentCleanedSanitized: visibleEntries.fullContentCleanedSanitized,
  fullContentSanitizedVersion: visibleEntries.fullContentSanitizedVersion,
  fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
  fullContentError: visibleEntries.fullContentError,
  contentHash: visibleEntries.contentHash,
  hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
  hasMarkedUnread: visibleEntries.hasMarkedUnread,
  hasStarred: visibleEntries.hasStarred,
  fetchFullContent: subscriptions.fetchFullContent,
};

/**
 * Fetch a single full entry by ID for a user.
 * Queries visibleEntries joined with feeds and subscriptions.
 * Returns null if the entry is not found or not visible to the user.
 */
export async function selectFullEntry(db: typeof dbType, userId: string, entryId: string) {
  const result = await db
    .select(fullEntrySelectFields)
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .leftJoin(subscriptions, eq(visibleEntries.subscriptionId, subscriptions.id))
    .where(and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId)))
    .limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * Resolve one family of an entry's sanitized content for display.
 *
 * Entry bodies come from untrusted feeds and are rendered via
 * `dangerouslySetInnerHTML` (and served to external clients such as MCP,
 * Google Reader, and Wallabag), so they must be sanitized. Sanitization is
 * persisted in the `*_sanitized` columns at write time (see
 * `@/server/html/sanitize-entry`), so the common case is a pure read of the
 * stored values. When the stored version doesn't match the current
 * `SANITIZER_VERSION` — pre-migration rows, or after the allow-list was
 * tightened — we re-sanitize from that family's raw columns and persist the
 * result (fire-and-forget) so subsequent reads are fast again.
 *
 * The content (`content_*`) and full-content (`full_content_*`) families are
 * versioned independently because they are written at different times, and are
 * resolved independently so callers that only serve the content family
 * (getEntry/getEntries) don't pay to fetch and re-sanitize full-content HTML
 * they never return.
 */
async function resolveSanitizedFamily(
  db: typeof dbType,
  entryId: string,
  family: "content" | "fullContent",
  stored: {
    originalSanitized: string | null;
    cleanedSanitized: string | null;
    version: number | null;
  }
): Promise<{ original: string | null; cleaned: string | null }> {
  // Fast path: already sanitized at the current version.
  if (stored.version === SANITIZER_VERSION) {
    return { original: stored.originalSanitized, cleaned: stored.cleanedSanitized };
  }

  // Heal path: fetch this family's raw columns (plus its content hash for the
  // persist guard), sanitize, and persist so we don't pay this again.
  const rawColumns =
    family === "content"
      ? {
          original: entries.contentOriginal,
          cleaned: entries.contentCleaned,
          hash: entries.contentHash,
        }
      : {
          original: entries.fullContentOriginal,
          cleaned: entries.fullContentCleaned,
          hash: entries.fullContentHash,
        };
  const [raw] = await db.select(rawColumns).from(entries).where(eq(entries.id, entryId)).limit(1);

  // Offload large bodies to a worker thread: this runs on the read request path
  // and, right after a SANITIZER_VERSION bump, can fire for many entries at once
  // as stored rows are healed, so it must not block the app-server event loop.
  const [original, cleaned] = await Promise.all([
    sanitizeEntryHtmlInWorker(raw?.original ?? null),
    sanitizeEntryHtmlInWorker(raw?.cleaned ?? null),
  ]);
  const resolved = { original, cleaned };

  // Persist the healed columns (fire-and-forget; a failed backfill must not fail
  // the read) under the shared version + content-hash CAS guard, so a re-sanitize
  // computed from now-stale raw can never clobber newer content. See
  // persistResanitizedFamily in @/server/services/resanitize.
  void persistResanitizedFamily(db, entryId, family, resolved, raw?.hash ?? null).catch((err) => {
    logger.warn("Failed to persist re-sanitized entry content", { entryId, family, err });
  });

  return resolved;
}

/**
 * Resolve both sanitized content families (see resolveSanitizedFamily).
 * Used by toFullEntry, which returns full-content fields.
 */
async function resolveSanitizedContent(
  db: typeof dbType,
  entryId: string,
  stored: {
    contentOriginalSanitized: string | null;
    contentCleanedSanitized: string | null;
    contentSanitizedVersion: number | null;
    fullContentOriginalSanitized: string | null;
    fullContentCleanedSanitized: string | null;
    fullContentSanitizedVersion: number | null;
  }
) {
  const [content, fullContent] = await Promise.all([
    resolveSanitizedFamily(db, entryId, "content", {
      originalSanitized: stored.contentOriginalSanitized,
      cleanedSanitized: stored.contentCleanedSanitized,
      version: stored.contentSanitizedVersion,
    }),
    resolveSanitizedFamily(db, entryId, "fullContent", {
      originalSanitized: stored.fullContentOriginalSanitized,
      cleanedSanitized: stored.fullContentCleanedSanitized,
      version: stored.fullContentSanitizedVersion,
    }),
  ]);

  return {
    contentOriginal: content.original,
    contentCleaned: content.cleaned,
    fullContentOriginal: fullContent.original,
    fullContentCleaned: fullContent.cleaned,
  };
}

/**
 * Transform a raw full entry row into the full-entry output shape.
 * Strips internal fields, resolves sanitized content, and defaults fetchFullContent.
 */
export async function toFullEntry(
  db: typeof dbType,
  row: NonNullable<Awaited<ReturnType<typeof selectFullEntry>>>
) {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hasStarred,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hasMarkedUnread,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    hasMarkedReadOnList,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    contentHash,
    contentOriginalSanitized,
    contentCleanedSanitized,
    contentSanitizedVersion,
    fullContentOriginalSanitized,
    fullContentCleanedSanitized,
    fullContentSanitizedVersion,
    ...rest
  } = row;

  const content = await resolveSanitizedContent(db, row.id, {
    contentOriginalSanitized,
    contentCleanedSanitized,
    contentSanitizedVersion,
    fullContentOriginalSanitized,
    fullContentCleanedSanitized,
    fullContentSanitizedVersion,
  });

  return {
    ...rest,
    contentOriginal: content.contentOriginal,
    contentCleaned: content.contentCleaned,
    fullContentOriginal: content.fullContentOriginal,
    fullContentCleaned: content.fullContentCleaned,
    fetchFullContent: row.fetchFullContent ?? false,
  };
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
 * Maps a raw row to EntryFull, resolving the sanitized content family (with
 * self-heal for rows whose stored sanitized version is stale). EntryFull
 * doesn't expose full-content fields, so that family is neither selected nor
 * resolved here.
 */
async function toEntryFull(
  db: typeof dbType,
  row: Awaited<ReturnType<typeof selectEntryFullRows>>[number]
): Promise<EntryFull> {
  const { contentOriginalSanitized, contentCleanedSanitized, contentSanitizedVersion, ...rest } =
    row;

  const content = await resolveSanitizedFamily(db, row.id, "content", {
    originalSanitized: contentOriginalSanitized,
    cleanedSanitized: contentCleanedSanitized,
    version: contentSanitizedVersion,
  });

  return {
    ...rest,
    contentOriginal: content.original,
    contentCleaned: content.cleaned,
  };
}

function selectEntryFullRows(db: typeof dbType, condition: SQL | undefined) {
  return db
    .select(entryFullSelectFields)
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(condition);
}

/**
 * Gets a single entry by ID with full content.
 *
 * Content fields are sanitized — this is the chokepoint that keeps raw feed
 * HTML from reaching any consumer (tRPC via toFullEntry, MCP, Google Reader,
 * Wallabag).
 */
export async function getEntry(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<EntryFull> {
  const result = await selectEntryFullRows(
    db,
    and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId))
  ).limit(1);

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  return toEntryFull(db, result[0]);
}

/**
 * Gets multiple entries by ID in a single query.
 * Returns entries in the same order as the input IDs.
 * Missing entries are silently skipped.
 * Content fields are sanitized (see getEntry).
 */
export async function getEntries(
  db: typeof dbType,
  userId: string,
  entryIds: string[]
): Promise<EntryFull[]> {
  if (entryIds.length === 0) return [];

  const results = await selectEntryFullRows(
    db,
    and(inArray(visibleEntries.id, entryIds), eq(visibleEntries.userId, userId))
  );

  // Build a map for O(1) lookup, then return in original order.
  // Sanitized-content resolution is a pure pass-through in the common case;
  // stale rows self-heal (one extra query each).
  const mapped = await Promise.all(results.map((row) => toEntryFull(db, row)));
  const resultMap = new Map<string, EntryFull>();
  for (const entry of mapped) {
    resultMap.set(entry.id, entry);
  }

  return entryIds.map((id) => resultMap.get(id)).filter((e): e is EntryFull => e != null);
}

/**
 * Marks entries as read or unread.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * read_changed_at timestamp. This prevents stale updates from overwriting newer
 * state. Supports per-entry timestamps for offline sync.
 *
 * Sets the implicit signal flags (vestiges of the removed entry-scoring feature):
 * - `has_marked_unread` whenever marking unread
 * - `has_marked_read_on_list` when marking read with `fromList`
 *
 * Returns the final state for all requested entries (with the context fields
 * callers need for cache updates) plus the absolute unread counts for every
 * affected list. Counts are computed once here and both returned and published,
 * so callers don't re-query them.
 *
 * Publishes an `entry_state_changed` SSE event for each entry that actually
 * changed, so a user's other tabs/devices stay in sync regardless of which
 * surface (tRPC, MCP, Google Reader, Wallabag) issued the mark. Publishing lives
 * here — not at each API boundary — so every current and future caller notifies
 * other tabs for free. Idempotent replays (an older `changedAt` losing the
 * `read_changed_at <= changedAt` guard) update no rows and therefore publish
 * nothing. Fire and forget.
 *
 * This publishes after the (autocommitted) UPDATEs complete. Today's callers
 * pass the global `db`, so that's always post-commit. If a future caller runs
 * this inside a transaction, move the publish to after the commit so a
 * rolled-back mark can't emit a phantom event.
 *
 * @param options.fromList - Whether the mark-read originated from the entry list
 *   (weak negative signal). Only meaningful when marking read.
 */
export async function markEntriesRead(
  db: typeof dbType,
  userId: string,
  entriesToMark: MarkReadEntry[],
  read: boolean,
  options: { fromList?: boolean } = {}
): Promise<{ entries: MarkReadEntryState[]; counts: BulkUnreadCounts }> {
  if (entriesToMark.length === 0) {
    return { entries: [], counts: await getBulkEntryRelatedCounts(db, userId, []) };
  }

  if (entriesToMark.length > 1000) {
    throw errors.validation("Maximum 1000 entries per request");
  }

  const now = new Date();

  // Build the SET clause, including implicit score signal flags
  const setClause: Record<string, unknown> = {
    read,
    updatedAt: now,
  };
  if (read && options.fromList) {
    // Marking read from the entry list → implicit -1
    setClause.hasMarkedReadOnList = true;
  } else if (!read) {
    // Marking unread from anywhere → implicit 0 (overrides read-on-list penalty)
    setClause.hasMarkedUnread = true;
  }

  // Group entries by timestamp for efficient batch updates. Most interactive
  // cases share a single timestamp; per-entry timestamps come from offline sync.
  const entriesByTimestamp = new Map<string, string[]>();
  for (const entry of entriesToMark) {
    const ts = (entry.changedAt ?? now).toISOString();
    const existing = entriesByTimestamp.get(ts) ?? [];
    existing.push(entry.id);
    entriesByTimestamp.set(ts, existing);
  }

  // Conditional update per timestamp group: only apply if incoming timestamp is
  // newer or equal than the stored read_changed_at (or it is NULL). `returning`
  // tells us which entries actually changed so idempotent replays don't publish.
  const changedIds = new Set<string>();
  for (const [tsIso, entryIds] of entriesByTimestamp) {
    const changedAt = new Date(tsIso);
    const updated = await db
      .update(userEntries)
      .set({
        ...setClause,
        readChangedAt: changedAt,
      })
      .where(
        and(
          eq(userEntries.userId, userId),
          inArray(userEntries.entryId, entryIds),
          or(isNull(userEntries.readChangedAt), lte(userEntries.readChangedAt, changedAt))
        )
      )
      .returning({ entryId: userEntries.entryId });
    for (const row of updated) {
      changedIds.add(row.entryId);
    }
  }

  // Always resolve final state for all requested entries, including the context
  // fields callers need for cache updates and count queries.
  const allEntryIds = entriesToMark.map((e) => e.id);
  const entries = await db
    .select({
      id: visibleEntries.id,
      subscriptionId: visibleEntries.subscriptionId,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      type: visibleEntries.type,
      updatedAt: visibleEntries.updatedAt,
    })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), inArray(visibleEntries.id, allEntryIds)));

  // Compute absolute counts once, for both the return value and the SSE publish.
  const counts = await getBulkEntryRelatedCounts(db, userId, entries);

  // Notify the user's other tabs/devices for the entries that actually changed,
  // carrying the absolute counts so they set them directly. See the function
  // doc for publish/transaction ordering. Fire and forget.
  const changed = entries.filter((entry) => changedIds.has(entry.id));
  if (changed.length > 0) {
    publishMarkReadStateChanges(userId, changed, counts);
  }

  return { entries, counts };
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

  // Filter by tag (ownership enforced by the shared subquery's tags.userId join)
  if (params.tagId) {
    const taggedFeedIdsSubquery = buildTaggedFeedIdsSubquery(db, params.tagId, params.userId);

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

  const updatedAt = new Date();
  const result = await db
    .update(userEntries)
    .set({
      read: true,
      readChangedAt: changedAt,
      updatedAt,
    })
    .where(and(...conditions))
    .returning({ entryId: userEntries.entryId });

  const entryIds = result.map((r) => r.entryId);

  // Notify the user's other tabs/devices. Mark-all-read is unbounded, so rather
  // than emitting a per-entry event (or shipping every affected id), we publish
  // one lightweight signal and let each connection invalidate its entry lists +
  // counts — the same thing the acting tab already does on success. Published
  // here (not in the router) so every caller — the tRPC mutation and the Google
  // Reader mark-all-as-read route — notifies other tabs. Fire and forget.
  //
  // This publishes after the (autocommitted) UPDATE above completes. Today's
  // callers pass the global `db`, so that's always post-commit. If a future
  // caller runs this inside a transaction, move the publish to after the commit
  // so a rolled-back mark-all-read can't emit a phantom event.
  if (entryIds.length > 0) {
    void publishMarkAllRead(params.userId, updatedAt).catch(() => {
      // Ignore publish errors - SSE is best-effort
    });
  }

  return entryIds;
}

/**
 * Stars or unstars an entry.
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * starred_changed_at timestamp. This prevents stale updates from overwriting newer state.
 *
 * Sets the `has_starred` implicit signal flag when starring (a vestige of the
 * removed entry-scoring feature).
 *
 * Returns the entry's final state plus the absolute unread counts for every
 * affected list. Counts are computed once here and both returned and published,
 * so callers don't re-query them.
 *
 * Publishes an `entry_state_changed` SSE event when the star state actually
 * changed, so a user's other tabs/devices stay in sync regardless of which
 * surface (tRPC, MCP, Google Reader, Wallabag) issued the change. Publishing
 * lives here — not at each API boundary — so every current and future caller
 * notifies other tabs for free. An idempotent replay (an older `changedAt`
 * losing the `starred_changed_at <= changedAt` guard) updates no rows and
 * therefore publishes nothing. Fire and forget.
 *
 * This publishes after the (autocommitted) UPDATE completes. Today's callers
 * pass the global `db`, so that's always post-commit. If a future caller runs
 * this inside a transaction, move the publish to after the commit so a
 * rolled-back change can't emit a phantom event.
 *
 * @param changedAt - When the user initiated the action. Defaults to now.
 */
export async function updateEntryStarred(
  db: typeof dbType,
  userId: string,
  entryId: string,
  starred: boolean,
  changedAt: Date = new Date()
): Promise<{ entry: EntryState; counts: UnreadCounts }> {
  // Build the SET clause, setting the implicit signal flag when starring
  const setClause: Record<string, unknown> = {
    starred,
    starredChangedAt: changedAt,
    updatedAt: new Date(),
  };
  if (starred) {
    setClause.hasStarred = true;
  }

  // Conditional update: only apply if incoming timestamp is newer or equal.
  // `returning` tells us whether the row actually changed so an idempotent
  // replay doesn't publish.
  const updated = await db
    .update(userEntries)
    .set(setClause)
    .where(
      and(
        eq(userEntries.userId, userId),
        eq(userEntries.entryId, entryId),
        lte(userEntries.starredChangedAt, changedAt)
      )
    )
    .returning({ entryId: userEntries.entryId });

  // Always resolve final state from visibleEntries (includes computed updatedAt)
  const result = await db
    .select({
      id: visibleEntries.id,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      updatedAt: visibleEntries.updatedAt,
    })
    .from(visibleEntries)
    .where(and(eq(visibleEntries.userId, userId), eq(visibleEntries.id, entryId)));

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  const entry = result[0];

  // Compute absolute counts once, for both the return value and the SSE publish.
  const counts = await getEntryRelatedCounts(db, userId, entryId);

  // Notify the user's other tabs/devices when the star state changed. See the
  // function doc for publish/transaction ordering. Fire and forget.
  if (updated.length > 0) {
    publishStarredStateChange(userId, entry, counts);
  }

  return { entry, counts };
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

  // count(DISTINCT id), not count(*): visible_entries emits one row per matching
  // subscription_feeds row, so an entry reachable through overlapping
  // subscriptions (redirect/merge history) would be counted multiple times.
  // This keeps the sidebar badge consistent with the counts.ts service, which
  // dedupes the same way.
  const result = await db
    .select({
      unread: sql<number>`count(DISTINCT ${visibleEntries.id}) FILTER (WHERE ${visibleEntries.read} = false)::int`,
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

  // count(DISTINCT id): dedupe entries reachable through overlapping
  // subscription_feeds rows (see countEntries).
  const result = await db
    .select({
      total: sql<number>`count(DISTINCT ${visibleEntries.id})::int`,
    })
    .from(visibleEntries)
    .where(and(...conditions));

  return result[0]?.total ?? 0;
}
