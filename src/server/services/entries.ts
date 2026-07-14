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
import type { db as dbType, DbOrTx } from "@/server/db";
import { entries, feeds, userEntries, subscriptions, visibleEntries } from "@/server/db/schema";
import { isValidUuid } from "@/lib/uuidv7";
import { SANITIZER_VERSION } from "@/server/html/sanitize";
import { sanitizeEntryHtmlInWorker } from "@/server/worker-thread/pool";
import { logger } from "@/lib/logger";
import { errors } from "@/server/trpc/errors";
import { publishMarkAllRead } from "@/server/redis/pubsub";
import {
  getBulkEntryRelatedCounts,
  getEntryRelatedCounts,
  getGlobalUnreadCounts,
  type BulkUnreadCounts,
  type UnreadCounts,
} from "./counts";
import { publishMarkReadStateChanges, publishStarredStateChange } from "./entry-events";
import { persistResanitizedFamily } from "./resanitize";
import {
  buildEntrySubscriptionFilter,
  buildEntryFilterConditions,
  buildTaggedSubscriptionIdsSubquery,
  buildUncategorizedSubscriptionIdsSubquery,
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
  offset?: number; // Skip this many rows (for page/offset-based compat APIs like Wallabag). Mutually exclusive with cursor.
  limit?: number;
  maxLimit?: number; // Override MAX_LIMIT (e.g., for Google Reader API which needs larger batches)
  publishedAfter?: Date; // Only entries published/fetched after this timestamp
  publishedBefore?: Date; // Only entries published/fetched before this timestamp
  updatedAfter?: Date; // Only entries modified at/after this timestamp (GREATEST(entry.updated_at, user_entries.updated_at); powers Wallabag `since` delta sync)
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
  offset?: number; // Skip this many rows (for page/offset-based compat APIs like Wallabag). Mutually exclusive with cursor.
  limit?: number;
  maxLimit?: number;
  publishedAfter?: Date;
  publishedBefore?: Date;
  updatedAfter?: Date; // Only entries modified at/after this timestamp (see ListEntriesParams.updatedAfter)
  showSpam: boolean;
}

export interface EntryListItem {
  id: string;
  // Google Reader item id (stored global serial). Ignored by the main app; used
  // by the Google Reader compat layer to address entries as int64 ids.
  greaderItemId: bigint;
  // Google Reader feed stream ids (stored serials), used only by the compat
  // layer to build each item's origin stream: the entry's subscription
  // (null for saved/uploaded and orphaned-starred entries) and its feed (used
  // for saved articles, which have no subscription — issue #730). Stripped from
  // main-app and MCP responses.
  subscriptionGreaderStreamId: bigint | null;
  feedGreaderStreamId: bigint;
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
  // Google Reader item id (stored global serial); see EntryListItem.
  greaderItemId: bigint;
  // Google Reader feed stream ids (stored serials); see EntryListItem.
  subscriptionGreaderStreamId: bigint | null;
  feedGreaderStreamId: bigint;
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
  greaderItemId: bigint;
  subscriptionGreaderStreamId: bigint | null;
  feedGreaderStreamId: bigint;
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
    greaderItemId: row.greaderItemId,
    subscriptionGreaderStreamId: row.subscriptionGreaderStreamId,
    feedGreaderStreamId: row.feedGreaderStreamId,
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
    // Both callers interpolate `id` into a uuid comparison, so a non-UUID would
    // reach Postgres as "invalid input syntax for type uuid" and 500 (Sentry
    // noise) — reject it here, matching the subscriptions cursor hardening. `ts`
    // is validated per-caller since its meaning differs (an ISO timestamp for
    // the timeline, a float rank for search).
    if (typeof parsed.ts !== "string" || typeof parsed.id !== "string" || !isValidUuid(parsed.id)) {
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
  greaderItemId: visibleEntries.greaderItemId,
  // Google Reader feed stream ids (compat layer only). The subscription's comes
  // from the view's LEFT JOIN (null for saved/orphaned); the feed's from the
  // feeds join every entry read performs (used for saved articles).
  subscriptionGreaderStreamId: visibleEntries.subscriptionGreaderStreamId,
  feedGreaderStreamId: feeds.greaderStreamId,
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
  // Whether this family has raw content to (re-)sanitize at all. Lets the read
  // path skip the heal for a family with no raw content instead of wasting a
  // SELECT + no-op sanitize + version-stamping UPDATE on it (see
  // resolveSanitizedFamily); matches the staleness query's RESANITIZE_NA rule.
  hasContentRaw: sql<boolean>`${visibleEntries.contentOriginal} IS NOT NULL OR ${visibleEntries.contentCleaned} IS NOT NULL`,
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
 * the full-content family and the subscription's fetchFullContent setting.
 */
const fullEntrySelectFields = {
  ...entryFullSelectFields,
  fullContentOriginalSanitized: visibleEntries.fullContentOriginalSanitized,
  fullContentCleanedSanitized: visibleEntries.fullContentCleanedSanitized,
  fullContentSanitizedVersion: visibleEntries.fullContentSanitizedVersion,
  // See hasContentRaw. Ordinary feed/email inserts leave the full-content raw
  // columns (and version) NULL, so without this the *first* read of nearly every
  // entry would take the heal path for a family that has nothing to sanitize.
  hasFullContentRaw: sql<boolean>`${visibleEntries.fullContentOriginal} IS NOT NULL OR ${visibleEntries.fullContentCleaned} IS NOT NULL`,
  fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
  fullContentError: visibleEntries.fullContentError,
  contentHash: visibleEntries.contentHash,
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
export async function resolveSanitizedFamily(
  db: typeof dbType,
  entryId: string,
  family: "content" | "fullContent",
  stored: {
    originalSanitized: string | null;
    cleanedSanitized: string | null;
    version: number | null;
    hasRaw: boolean;
  }
): Promise<{ original: string | null; cleaned: string | null }> {
  // Fast path: already sanitized at (or beyond) the current version. `>=`, not
  // `===`, so a row a newer release wrote at a higher version (during an
  // expand/contract rollout, or when this is an old release running after a
  // rollback) is served as-is instead of pointlessly re-sanitized every read —
  // the persist CAS is strictly-less-than and would reject the downgrade anyway.
  if (stored.version !== null && stored.version >= SANITIZER_VERSION) {
    return { original: stored.originalSanitized, cleaned: stored.cleanedSanitized };
  }

  // Nothing to heal: a family with no raw content can't be re-sanitized, and its
  // stored sanitized columns are already NULL. Ordinary feed/email inserts leave
  // the full-content family's raw columns and version NULL, so without this guard
  // the *first* read of nearly every entry (and every read after a
  // SANITIZER_VERSION bump) would take the heal path below — a wasted SELECT, two
  // no-op sanitize calls, and a fire-and-forget UPDATE stamping the version on a
  // family that holds no content. Skip it, matching the bulk-resanitize
  // staleness query, which treats a no-raw family as not stale (RESANITIZE_NA
  // in resanitize.ts).
  if (!stored.hasRaw) {
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
    hasContentRaw: boolean;
    fullContentOriginalSanitized: string | null;
    fullContentCleanedSanitized: string | null;
    fullContentSanitizedVersion: number | null;
    hasFullContentRaw: boolean;
  }
) {
  const [content, fullContent] = await Promise.all([
    resolveSanitizedFamily(db, entryId, "content", {
      originalSanitized: stored.contentOriginalSanitized,
      cleanedSanitized: stored.contentCleanedSanitized,
      version: stored.contentSanitizedVersion,
      hasRaw: stored.hasContentRaw,
    }),
    resolveSanitizedFamily(db, entryId, "fullContent", {
      originalSanitized: stored.fullContentOriginalSanitized,
      cleanedSanitized: stored.fullContentCleanedSanitized,
      version: stored.fullContentSanitizedVersion,
      hasRaw: stored.hasFullContentRaw,
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
    contentHash,
    contentOriginalSanitized,
    contentCleanedSanitized,
    contentSanitizedVersion,
    hasContentRaw,
    fullContentOriginalSanitized,
    fullContentCleanedSanitized,
    fullContentSanitizedVersion,
    hasFullContentRaw,
    ...rest
  } = row;

  const content = await resolveSanitizedContent(db, row.id, {
    contentOriginalSanitized,
    contentCleanedSanitized,
    contentSanitizedVersion,
    hasContentRaw,
    fullContentOriginalSanitized,
    fullContentCleanedSanitized,
    fullContentSanitizedVersion,
    hasFullContentRaw,
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
  // `cursor` and `offset` are two different ways to page and must not be combined:
  // the cursor predicate would narrow the window and offset would then skip *more*
  // rows on top of it, silently double-skipping. Callers use one or the other.
  if (params.cursor && params.offset) {
    throw new Error("listEntries: `cursor` and `offset` are mutually exclusive");
  }

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

  // Apply subscription filters (subscriptionId, tagId, uncategorized)
  const subscriptionFilter = await buildEntrySubscriptionFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    params.userId
  );

  if (subscriptionFilter.isEmpty) {
    return { items: [], nextCursor: undefined };
  }

  if (subscriptionFilter.subscriptionIdsCondition !== null) {
    conditions.push(
      inArray(visibleEntries.subscriptionId, subscriptionFilter.subscriptionIdsCondition)
    );
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
  // "Modified since" filter (Wallabag `since` delta sync). visibleEntries.updatedAt is
  // GREATEST(entry.updated_at, user_entries.updated_at), so this captures new saves,
  // content refetches, AND read/star state changes — the same value we return as the
  // entry's updated_at, so the filter and the reported timestamp can't disagree.
  //
  // The GREATEST spans two tables so no single index covers it — but here (unlike
  // the old sync.events, which #1105 rewrote into an index-driven UNION) it is only
  // a RESIDUAL filter, not the sort key: the query still sorts by
  // publishedOrFetchedAt (idx_user_entries_published_or_fetched) with LIMIT
  // pushdown. The Wallabag caller also scopes to type='saved', so the scan is
  // bounded to the user's read-it-later library, not the whole timeline. That keeps
  // the acute #1105 problem (a mandatory full sort of the user's entire history)
  // from applying, so this path deliberately keeps the simple residual filter.
  if (params.updatedAfter) {
    conditions.push(sql`${visibleEntries.updatedAt} >= ${params.updatedAfter}`);
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
    // ts is cast to ::timestamptz below; reject a non-date string here so it
    // surfaces as a validation error rather than a Postgres cast 500.
    if (Number.isNaN(Date.parse(ts))) {
      throw errors.validation("Invalid cursor format");
    }
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

  // visible_entries emits exactly one row per (user, entry) — it joins
  // subscriptions on the stamped user_entries.subscription_id (migration 0087)
  // — so no DISTINCT ON dedup is needed and the (sortColumn, id) keyset cursor
  // resumes cleanly over unique rows.
  const queryResults = await db
    .select({
      id: visibleEntries.id,
      greaderItemId: visibleEntries.greaderItemId,
      subscriptionGreaderStreamId: visibleEntries.subscriptionGreaderStreamId,
      feedGreaderStreamId: feeds.greaderStreamId,
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
    .limit(limit + 1)
    .offset(params.offset ?? 0);

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

  // Apply subscription filters (subscriptionId, tagId, uncategorized)
  const subscriptionFilter = await buildEntrySubscriptionFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    params.userId
  );

  if (subscriptionFilter.isEmpty) {
    return { items: [], nextCursor: undefined };
  }

  if (subscriptionFilter.subscriptionIdsCondition !== null) {
    conditions.push(
      inArray(visibleEntries.subscriptionId, subscriptionFilter.subscriptionIdsCondition)
    );
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
  if (params.updatedAfter) {
    conditions.push(sql`${visibleEntries.updatedAt} >= ${params.updatedAfter}`);
  }

  // Cursor for search results (based on rank)
  if (params.cursor) {
    const { ts: rankStr, id } = decodeCursor(params.cursor);
    const cursorRank = parseFloat(rankStr);
    // The search cursor encodes a float rank in the ts field; reject a
    // non-numeric value so NaN never reaches the rank comparison.
    if (!Number.isFinite(cursorRank)) {
      throw errors.validation("Invalid cursor format");
    }
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
      id: visibleEntries.id,
      greaderItemId: visibleEntries.greaderItemId,
      subscriptionGreaderStreamId: visibleEntries.subscriptionGreaderStreamId,
      feedGreaderStreamId: feeds.greaderStreamId,
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
      // Alias to avoid colliding with visibleEntries.title (both are "title")
      // inside the subquery, which would make the outer reference ambiguous.
      feedTitle: sql<string | null>`${feeds.title}`.as("feed_title"),
      // Alias required so the outer query can reference this raw SQL field.
      rank: rankColumn.as("rank"),
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .where(and(...conditions))
    .as("ranked");

  const queryResults = await db
    .select({
      id: rankedSubquery.id,
      greaderItemId: rankedSubquery.greaderItemId,
      subscriptionGreaderStreamId: rankedSubquery.subscriptionGreaderStreamId,
      feedGreaderStreamId: rankedSubquery.feedGreaderStreamId,
      feedId: rankedSubquery.feedId,
      type: rankedSubquery.type,
      url: rankedSubquery.url,
      title: rankedSubquery.title,
      author: rankedSubquery.author,
      summary: rankedSubquery.summary,
      publishedAt: rankedSubquery.publishedAt,
      fetchedAt: rankedSubquery.fetchedAt,
      read: rankedSubquery.read,
      starred: rankedSubquery.starred,
      updatedAt: rankedSubquery.updatedAt,
      subscriptionId: rankedSubquery.subscriptionId,
      siteName: rankedSubquery.siteName,
      feedTitle: rankedSubquery.feedTitle,
      rank: rankedSubquery.rank,
    })
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
    nextCursor = encodeCursor(Number(lastEntry.rank).toString(), lastEntry.id);
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
  const {
    contentOriginalSanitized,
    contentCleanedSanitized,
    contentSanitizedVersion,
    hasContentRaw,
    ...rest
  } = row;

  const content = await resolveSanitizedFamily(db, row.id, "content", {
    originalSanitized: contentOriginalSanitized,
    cleanedSanitized: contentCleanedSanitized,
    version: contentSanitizedVersion,
    hasRaw: hasContentRaw,
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
 * Returns the final state for all requested entries (with the context fields
 * callers need for cache updates) plus the absolute unread counts for every
 * affected list. Counts are computed once here and both returned and published,
 * so callers don't re-query them.
 *
 * A row being WRITTEN is not the same as the read value CHANGING (issue #1118):
 * re-asserting a state the entry already has (the common Google Reader/Wallabag
 * resync pattern) still writes the row to advance the `read_changed_at`
 * last-write-wins watermark — dropping that write would let an older conflicting
 * update win later — but nothing the user can see changed, so `changed` contains
 * only entries whose read value actually flipped, and the unread-count
 * aggregation (the dominant cost of this path) runs only when something flipped.
 * `counts` is undefined otherwise; callers treat "no counts" as "counts didn't
 * change".
 *
 * The two roles are carried by two columns (issue #1118 Part 2): `read_changed_at`
 * is the last-writer-wins watermark and advances on every accepted write, while
 * `updated_at` is the "meaningful change" timestamp that drives delta sync
 * (`sync.events`, Wallabag `since`, both through `visible_entries.updated_at`) and
 * moves ONLY on a real flip. So a same-value re-assert advances the watermark but
 * leaves `updated_at` alone, and offline/polling clients don't re-fetch it.
 *
 * Publishes an `entry_state_changed` SSE event for each entry whose value
 * actually flipped, so a user's other tabs/devices stay in sync regardless of
 * which surface (tRPC, MCP, Google Reader, Wallabag) issued the mark. Publishing
 * lives here — not at each API boundary — so every current and future caller
 * notifies other tabs for free. Idempotent replays (an older `changedAt` losing
 * the `read_changed_at <= changedAt` guard) update no rows, and same-value
 * re-asserts flip nothing; neither publishes. Fire and forget.
 *
 * This publishes after the (autocommitted) UPDATEs complete. Callers that pass
 * the global `db` get post-commit publishing for free. A caller running this
 * inside a transaction must pass `publish: false` and publish the returned
 * `changed`+`counts` itself after the commit, so a rolled-back mark can't emit
 * a phantom event.
 *
 * @param options.publish - Whether to publish `entry_state_changed` events here
 *   (default true). Pass false when calling inside a transaction and publish the
 *   returned `changed`/`counts` after the commit.
 */
export async function markEntriesRead(
  db: DbOrTx,
  userId: string,
  entriesToMark: MarkReadEntry[],
  read: boolean,
  options: { publish?: boolean } = {}
): Promise<{
  entries: MarkReadEntryState[];
  changed: MarkReadEntryState[];
  counts?: BulkUnreadCounts;
}> {
  if (entriesToMark.length === 0) {
    return { entries: [], changed: [] };
  }

  if (entriesToMark.length > 1000) {
    throw errors.validation("Maximum 1000 entries per request");
  }

  const now = new Date();

  // Apply every entry's per-entry changedAt in a single UPDATE ... FROM
  // (VALUES ...). Offline sync can send a distinct timestamp per entry; the
  // previous code grouped by timestamp and issued one UPDATE per distinct value
  // — up to N sequential round-trips outside a transaction. One statement does
  // it atomically. The per-row `read_changed_at <= v.ts` guard preserves the
  // idempotent last-write-wins semantics.
  //
  // The self-join on `prev` captures each row's pre-update read value in the
  // same statement (RETURNING only sees new values before PG 18's `old.*`), so
  // we can tell a real flip from a same-value watermark bump without a separate
  // pre-SELECT and its wider TOCTOU window.
  const rows = entriesToMark.map(
    (entry) => sql`(${entry.id}::uuid, ${(entry.changedAt ?? now).toISOString()}::timestamptz)`
  );

  // `updated_at` is the "meaningful change" timestamp that drives delta sync
  // (`sync.events` and Wallabag `since`, both via `visible_entries.updated_at =
  // GREATEST(entry, user_entry)`), so it moves ONLY when the read value actually
  // flips — a same-value re-assert must not re-deliver the entry to offline
  // clients (issue #1118 Part 2). The last-writer-wins watermark
  // (`read_changed_at`) is a SEPARATE column and still advances on every
  // accepted write, so cross-device conflict resolution is unchanged.
  const updated = await db.execute<{ entry_id: string; old_read: boolean }>(sql`
    UPDATE user_entries AS ue
    SET read = ${read},
        updated_at = CASE WHEN prev.read <> ${read} THEN ${now} ELSE ue.updated_at END,
        read_changed_at = v.ts
    FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(entry_id, ts)
    JOIN user_entries AS prev
      ON prev.user_id = ${userId}::uuid
      AND prev.entry_id = v.entry_id
    WHERE ue.user_id = ${userId}::uuid
      AND ue.entry_id = v.entry_id
      AND (ue.read_changed_at IS NULL OR ue.read_changed_at <= v.ts)
    RETURNING ue.entry_id AS entry_id, prev.read AS old_read
  `);
  // Rows whose read value actually flipped — the only ones that warrant SSE
  // events and count recomputation. Same-value writes still advanced the
  // watermark above.
  const flippedIds = new Set(
    updated.rows.filter((row) => row.old_read !== read).map((row) => row.entry_id)
  );

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

  // Compute absolute counts once, for both the return value and the SSE
  // publish — but only when a value actually flipped. A batch of pure
  // re-asserts changes no count, so the aggregation (several scans of
  // visible_entries) would be wasted work (issue #1118). Counts cover the
  // flipped entries' lists, which are exactly the lists that moved.
  const changed = entries.filter((entry) => flippedIds.has(entry.id));
  const counts =
    changed.length > 0 ? await getBulkEntryRelatedCounts(db, userId, changed) : undefined;

  // Notify the user's other tabs/devices for the entries that actually flipped,
  // carrying the absolute counts so they set them directly. See the function
  // doc for publish/transaction ordering. Fire and forget.
  //
  // Transactional callers pass `publish: false` and publish `changed`+`counts`
  // themselves after the commit, so a rolled-back mark can't emit a phantom
  // event (see the function doc).
  if (options.publish !== false && changed.length > 0 && counts) {
    publishMarkReadStateChanges(userId, changed, counts);
  }

  return { entries, changed, counts };
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
    /**
     * Whether to include spam entries, matching the user's preference. When
     * false (the default), only entries visible via `visible_entries` with
     * `is_spam = false` are marked — otherwise "mark all read" would also flip
     * hidden spam and unsubscribed-orphan `user_entries` rows the user never
     * saw, which would surface as already-read if they later enable showSpam.
     */
    showSpam: boolean;
  }
): Promise<string[]> {
  const changedAt = params.changedAt ?? new Date();

  const conditions: SQL[] = [
    eq(userEntries.userId, params.userId),
    eq(userEntries.read, false),
    or(isNull(userEntries.readChangedAt), lte(userEntries.readChangedAt, changedAt))!,
  ];

  // Only mark entries the user can actually see, matching listEntries/countEntries
  // (which go through visible_entries). This excludes hidden spam (unless
  // showSpam) and unsubscribed-feed orphans that aren't starred/saved.
  const visibleConditions = [eq(visibleEntries.userId, params.userId)];
  if (!params.showSpam) {
    visibleConditions.push(eq(visibleEntries.isSpam, false));
  }
  conditions.push(
    inArray(
      userEntries.entryId,
      db
        .select({ id: visibleEntries.id })
        .from(visibleEntries)
        .where(and(...visibleConditions))
    )
  );

  // Filter by explicit feed IDs (used by GReader route after stream resolution)
  if (params.feedIds) {
    const entryIdsSubquery = db
      .select({ id: entries.id })
      .from(entries)
      .where(inArray(entries.feedId, params.feedIds));

    conditions.push(inArray(userEntries.entryId, entryIdsSubquery));
  }

  // Filter by subscriptionId, matching the entry's stamped attribution. The
  // subscriptions subquery (active-only, user-scoped) validates ownership
  // inside the statement, so a foreign or unsubscribed subscription id matches
  // nothing. (The user_feeds view is display-only — scoping checks query the
  // subscriptions table directly.)
  if (params.subscriptionId) {
    conditions.push(
      inArray(
        userEntries.subscriptionId,
        db
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            and(
              eq(subscriptions.id, params.subscriptionId),
              eq(subscriptions.userId, params.userId),
              isNull(subscriptions.unsubscribedAt)
            )
          )
      )
    );
  }

  // Filter by tag (ownership enforced by the shared subquery's tags.userId join)
  if (params.tagId) {
    conditions.push(
      inArray(
        userEntries.subscriptionId,
        buildTaggedSubscriptionIdsSubquery(db, params.tagId, params.userId)
      )
    );
  }

  // Filter by uncategorized (no tags). Reuse the shared subquery builder so this
  // stays in sync with buildEntrySubscriptionFilter (listEntries/countEntries).
  if (params.uncategorized) {
    conditions.push(
      inArray(
        userEntries.subscriptionId,
        buildUncategorizedSubscriptionIdsSubquery(db, params.userId)
      )
    );
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
 * Returns the entry's final state plus the absolute unread counts for every
 * affected list. Counts are computed once here and both returned and published,
 * so callers don't re-query them.
 *
 * A row being written is not the same as the starred value changing (issue
 * #1118): re-asserting a state the entry already has still writes the row to
 * advance the `starred_changed_at` last-write-wins watermark — dropping that
 * write would let an older conflicting update win later — but the count
 * aggregation runs and the SSE event publishes only when the value actually
 * flipped. `counts` is undefined otherwise; callers treat "no counts" as
 * "counts didn't change".
 *
 * As in markEntriesRead (issue #1118 Part 2), `starred_changed_at` is the
 * last-writer-wins watermark (advances on every accepted write) while `updated_at`
 * is the delta-sync "meaningful change" timestamp and moves ONLY on a real flip,
 * so a same-value re-assert never re-delivers the entry to offline/polling clients.
 *
 * Publishes an `entry_state_changed` SSE event when the star state actually
 * changed, so a user's other tabs/devices stay in sync regardless of which
 * surface (tRPC, MCP, Google Reader, Wallabag) issued the change. Publishing
 * lives here — not at each API boundary — so every current and future caller
 * notifies other tabs for free. An idempotent replay (an older `changedAt`
 * losing the `starred_changed_at <= changedAt` guard) updates no rows, and a
 * same-value re-assert flips nothing; neither publishes. Fire and forget.
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
): Promise<{ entry: EntryState; counts?: UnreadCounts }> {
  // Conditional update: only apply if incoming timestamp is newer or equal
  // (starred_changed_at is NOT NULL with a default, so no NULL guard needed).
  // Date params bind un-cast here because SET/WHERE column context supplies the
  // timestamptz type — unlike markEntriesRead's bare VALUES tuples, which need
  // an explicit ::timestamptz cast.
  // The self-join on `prev` captures the pre-update starred value in the same
  // statement (RETURNING only sees new values before PG 18's `old.*`), so we
  // can tell a real flip from a same-value watermark bump without a separate
  // pre-SELECT and its wider TOCTOU window.
  // `updated_at` is the "meaningful change" timestamp that drives delta sync
  // (see markEntriesRead), so it moves ONLY when the starred value actually
  // flips — a same-value re-assert must not re-deliver the entry (issue #1118
  // Part 2). The `starred_changed_at` last-writer-wins watermark is a separate
  // column and still advances on every accepted write.
  const updated = await db.execute<{ old_starred: boolean }>(sql`
    UPDATE user_entries AS ue
    SET starred = ${starred},
        starred_changed_at = ${changedAt},
        updated_at = CASE WHEN prev.starred <> ${starred} THEN ${new Date()} ELSE ue.updated_at END
    FROM user_entries AS prev
    WHERE ue.user_id = ${userId}::uuid
      AND ue.entry_id = ${entryId}::uuid
      AND prev.user_id = ue.user_id
      AND prev.entry_id = ue.entry_id
      AND ue.starred_changed_at <= ${changedAt}
    RETURNING prev.starred AS old_starred
  `);
  // The starred value actually flipped only if a row was written AND its old
  // value differed. A same-value write advanced the watermark above.
  const flipped = updated.rows.length > 0 && updated.rows[0].old_starred !== starred;

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

  // Compute absolute counts once, for both the return value and the SSE
  // publish — but only when the value actually flipped; a re-assert changes no
  // count, so the aggregation would be wasted work (issue #1118).
  const counts = flipped ? await getEntryRelatedCounts(db, userId, entryId) : undefined;

  // Notify the user's other tabs/devices when the star state actually flipped.
  // See the function doc for publish/transaction ordering. Fire and forget.
  if (flipped && counts) {
    publishStarredStateChange(userId, entry, counts);
  }

  return { entry, counts };
}

/**
 * Counts unread entries with filters. Spam is NEVER counted (issue #1117):
 * unread counts exclude spam everywhere, regardless of the user's showSpam
 * list preference — matching the denormalized counters that serve the other
 * badges.
 *
 * The three sidebar top-level badge shapes (`{}`, `{starredOnly}`,
 * `{type:'saved'}`) are served straight from the counters (O(subscriptions)
 * arithmetic); every other filter combination falls back to the
 * visible_entries scan.
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
  }
): Promise<{ unread: number }> {
  // Counter fast-path for the global badge shapes. Deliberately conservative:
  // any scoping or shape-altering filter falls through to the scan.
  const unscoped =
    !params.subscriptionId &&
    !params.tagId &&
    !params.uncategorized &&
    !params.excludeTypes?.length &&
    !params.readOnly &&
    !params.unstarredOnly;
  if (unscoped) {
    if (!params.type && !params.starredOnly) {
      const counts = await getGlobalUnreadCounts(db, userId);
      return { unread: counts.allUnread };
    }
    if (params.starredOnly && !params.type) {
      const counts = await getGlobalUnreadCounts(db, userId);
      return { unread: counts.starredUnread };
    }
    if (params.type === "saved" && !params.starredOnly) {
      const counts = await getGlobalUnreadCounts(db, userId);
      return { unread: counts.savedUnread };
    }
  }

  const conditions = [eq(visibleEntries.userId, userId)];

  // Apply subscription filters (subscriptionId, tagId, uncategorized)
  const subscriptionFilter = await buildEntrySubscriptionFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    userId
  );

  if (subscriptionFilter.isEmpty) {
    return { unread: 0 };
  }

  if (subscriptionFilter.subscriptionIdsCondition !== null) {
    conditions.push(
      inArray(visibleEntries.subscriptionId, subscriptionFilter.subscriptionIdsCondition)
    );
  }

  // Apply entry filter conditions. showSpam is hard-coded false: unread counts
  // never include spam (the list may, when the user opts in — the badge doesn't).
  conditions.push(...buildEntryFilterConditions({ ...params, showSpam: false }));

  // Callers only consume `unread`, so push read=false into the WHERE clause
  // (rather than a FILTER over all visible entries) — this lets the partial
  // idx_user_entries_unread index drive the scan instead of counting every
  // visible entry, matching how counts.ts computes unread counts.
  conditions.push(eq(visibleEntries.read, false));

  // The view emits one row per (user, entry) (migration 0087), so count(*) is
  // exact and consistent with the counts.ts service.
  const result = await db
    .select({
      unread: sql<number>`count(*)::int`,
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
    updatedAfter?: Date;
    showSpam: boolean;
  }
): Promise<number> {
  const conditions = [eq(visibleEntries.userId, userId)];

  const subscriptionFilter = await buildEntrySubscriptionFilter(
    db,
    {
      subscriptionId: params.subscriptionId,
      tagId: params.tagId,
      uncategorized: params.uncategorized,
    },
    userId
  );

  if (subscriptionFilter.isEmpty) {
    return 0;
  }

  if (subscriptionFilter.subscriptionIdsCondition !== null) {
    conditions.push(
      inArray(visibleEntries.subscriptionId, subscriptionFilter.subscriptionIdsCondition)
    );
  }

  conditions.push(...buildEntryFilterConditions(params));

  if (params.updatedAfter) {
    conditions.push(sql`${visibleEntries.updatedAt} >= ${params.updatedAfter}`);
  }

  // One row per (user, entry), so count(*) is exact (see countEntries).
  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(visibleEntries)
    .where(and(...conditions));

  return result[0]?.total ?? 0;
}
