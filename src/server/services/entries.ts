/**
 * Entries Service
 *
 * Business logic for entry operations. Used by both tRPC routers and MCP server.
 */

import { z } from "zod";
import {
  eq,
  and,
  desc,
  asc,
  inArray,
  gt,
  sql,
  isNull,
  isNotNull,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import type { db as dbType, DbOrTx } from "@/server/db";
import { entries, feeds, userEntries, subscriptions, visibleEntries } from "@/server/db/schema";
import { parseTimestamptzOrNull } from "@/server/db/temporal";
import { sanitizeEntryContentFamily } from "@/server/html/sanitize-entry";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
import { showsFullContent } from "@/lib/narration/select-content";
import { errors } from "@/server/trpc/errors";
import { publishMarkAllRead } from "@/server/redis/pubsub";
import { createCursorCodec, cursorUuid } from "./cursor";
import { getBulkEntryRelatedCounts, getGlobalUnreadCounts, type BulkUnreadCounts } from "./counts";
import { publishMarkReadStateChanges, publishStarredStateChanges } from "./entry-events";
import {
  buildEntrySubscriptionFilter,
  buildEntryFilterConditions,
  buildEntriesInSubscriptionsCondition,
  buildTaggedSubscriptionIdsSubquery,
  verifySubscriptionOwnership,
  buildUncategorizedSubscriptionIdsSubquery,
  entryFeedTitleSql,
  entrySubscriptionJoin,
} from "./entry-filters";

// ============================================================================
// Types
// ============================================================================

export interface ListEntriesParams {
  userId: string;
  query?: string; // Optional full-text search query — delegates to searchEntries (#1249)
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
  // Which column to sort by (default: published). "published" = publish/fetch
  // time (index-backed); "readChanged" = read-state-change time (the recently-read
  // view, which also excludes never-read entries); "archived" = read-state-change
  // time WITHOUT the recently-read exclusion (Wallabag sort=archived). All three
  // are served by an existing index; there is deliberately no "updated"
  // (GREATEST(entry, user_entry)) sort — it can't be index-served (see #1070), so
  // the Wallabag route approximates sort=updated as the default published sort.
  sortBy?: "published" | "readChanged" | "archived";
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
  // (null for saved/uploaded articles) and its feed (used for saved articles,
  // which have no subscription — issue #730). Stripped from main-app and MCP
  // responses.
  subscriptionGreaderStreamId: bigint | null;
  feedGreaderStreamId: bigint;
  subscriptionId: string | null;
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
  /** When read state last changed (Recently Read's order); null if it never has. */
  readChangedAt: Date | null;
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
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  author: string | null;
  contentOriginal: string | null;
  contentCleaned: string | null;
  /**
   * The sanitized fetched full article when the entry view shows it instead of
   * the feed content (`showsFullContent`), else null. External clients serve
   * this first so they match the web app.
   */
  fullContent: string | null;
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
  readChangedAt: Date | null;
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
    greaderItemId: row.greaderItemId,
    subscriptionGreaderStreamId: row.subscriptionGreaderStreamId,
    feedGreaderStreamId: row.feedGreaderStreamId,
    subscriptionId: row.subscriptionId,
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

// ============================================================================
// Sanitized Content Resolution
// ============================================================================

/**
 * Columns shared by the list and search queries (each adds its feed title and
 * sort key). Callers must join `feeds`.
 */
const entryListSelectFields = {
  id: visibleEntries.id,
  greaderItemId: visibleEntries.greaderItemId,
  subscriptionGreaderStreamId: visibleEntries.subscriptionGreaderStreamId,
  feedGreaderStreamId: feeds.greaderStreamId,
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
  subscriptionId: visibleEntries.subscriptionId,
  siteName: visibleEntries.siteName,
};

/**
 * Base select fields shared by every full-entry read (getEntry/getEntries and
 * selectFullEntry). Selects the **raw** content columns; the read path
 * sanitizes them per read (see `toEntryFull`/`toFullEntry`) so raw untrusted
 * HTML never leaves the service layer.
 */
const entryFullSelectFields = {
  id: visibleEntries.id,
  greaderItemId: visibleEntries.greaderItemId,
  // Google Reader feed stream ids (compat layer only). The subscription's comes
  // from the view's LEFT JOIN (null for saved); the feed's from the
  // feeds join every entry read performs (used for saved articles).
  subscriptionGreaderStreamId: visibleEntries.subscriptionGreaderStreamId,
  feedGreaderStreamId: feeds.greaderStreamId,
  type: visibleEntries.type,
  url: visibleEntries.url,
  title: visibleEntries.title,
  author: visibleEntries.author,
  // Raw (untrusted) content, sanitized on read before it leaves the service.
  contentOriginal: visibleEntries.contentOriginal,
  contentCleaned: visibleEntries.contentCleaned,
  summary: visibleEntries.summary,
  publishedAt: visibleEntries.publishedAt,
  fetchedAt: visibleEntries.fetchedAt,
  read: visibleEntries.read,
  starred: visibleEntries.starred,
  updatedAt: visibleEntries.updatedAt,
  subscriptionId: visibleEntries.subscriptionId,
  siteName: visibleEntries.siteName,
  feedTitle: entryFeedTitleSql(),
  feedUrl: feeds.url,
  unsubscribeUrl: visibleEntries.unsubscribeUrl,
};

/**
 * Superset selected by `selectFullEntry` for the tRPC full-entry view: adds
 * both full-content variants (the view can toggle back to feed content) and the
 * subscription's fetchFullContent setting.
 */
const fullEntrySelectFields = {
  ...entryFullSelectFields,
  // Raw (untrusted) full-content columns, sanitized on read (see toFullEntry).
  fullContentOriginal: visibleEntries.fullContentOriginal,
  fullContentCleaned: visibleEntries.fullContentCleaned,
  fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
  fullContentError: visibleEntries.fullContentError,
  contentHash: visibleEntries.contentHash,
  fetchFullContent: subscriptions.fetchFullContent,
  readChangedAt: visibleEntries.readChangedAt,
};

/**
 * Fetch a single full entry by ID for a user.
 * Queries visibleEntries joined with feeds and subscriptions.
 * Returns null if the entry is not found or not visible to the user.
 */
function selectFullEntryRows(db: typeof dbType, where: SQL | undefined) {
  return db
    .select(fullEntrySelectFields)
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .leftJoin(subscriptions, entrySubscriptionJoin(visibleEntries))
    .where(where);
}

export async function selectFullEntry(db: typeof dbType, userId: string, entryId: string) {
  const result = await selectFullEntryRows(
    db,
    and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId))
  ).limit(1);

  return result.length > 0 ? result[0] : null;
}

/**
 * The stored content family of an entry, plus the fields the AI paths key their
 * caches on (`contentHash`/`fullContentHash`) and prompt with (`title`).
 * Deliberately one shape for both callers even though each reads a subset: the
 * point of the shared read is that they can't drift, and the row it saves is
 * noise next to the LLM call that follows.
 */
const entryRawContentSelectFields = {
  title: visibleEntries.title,
  // Raw (untrusted) content — see getOwnedEntryRawContent.
  contentOriginal: visibleEntries.contentOriginal,
  contentCleaned: visibleEntries.contentCleaned,
  contentHash: visibleEntries.contentHash,
  fullContentOriginal: visibleEntries.fullContentOriginal,
  fullContentCleaned: visibleEntries.fullContentCleaned,
  fullContentHash: visibleEntries.fullContentHash,
};

export interface OwnedEntryRawContent {
  title: string | null;
  contentOriginal: string | null;
  contentCleaned: string | null;
  contentHash: string;
  fullContentOriginal: string | null;
  fullContentCleaned: string | null;
  fullContentHash: string | null;
}

/**
 * Fetch an entry's stored content for a user, enforcing ownership through
 * `visible_entries` — the same visibility rule `listEntries`/`getEntry` apply,
 * so an entry the user can't see in a list can't be reached through a side
 * door either (a raw `user_entries` join would let e.g. an unsubscribed,
 * unstarred entry through).
 *
 * Unlike every other read out of this service, the content is **raw**: this is
 * for callers that hash it or feed it to an LLM, not ones that return it.
 * Anything that reaches a client must be sanitized first (`sanitizeEntryHtml`;
 * the ordinary read path does it in `toFullEntry`).
 *
 * @throws entryNotFound if the entry doesn't exist or isn't visible to the user
 */
export async function getOwnedEntryRawContent(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<OwnedEntryRawContent> {
  const result = await db
    .select(entryRawContentSelectFields)
    .from(visibleEntries)
    .where(and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId)))
    .limit(1);

  if (result.length === 0) {
    throw errors.entryNotFound();
  }

  return result[0];
}

/**
 * Sanitize both content families of a full entry for display.
 *
 * Entry bodies come from untrusted feeds and are rendered via
 * `dangerouslySetInnerHTML` (and served to external clients such as MCP,
 * Google Reader, and Wallabag), so they must be sanitized. As of issue #1282
 * sanitization is not persisted — the native sanitizer is fast enough to run on
 * every read — so the read query selects the raw columns and this sanitizes
 * them (large bodies off the event loop; the full-content original only when
 * cleaned is NULL). See `sanitizeEntryContentFamily`.
 */
async function sanitizeFullEntryContent(row: {
  contentOriginal: string | null;
  contentCleaned: string | null;
  fullContentOriginal: string | null;
  fullContentCleaned: string | null;
}) {
  const [content, fullContent] = await Promise.all([
    sanitizeEntryContentFamily("content", {
      original: row.contentOriginal,
      cleaned: row.contentCleaned,
    }),
    sanitizeEntryContentFamily("fullContent", {
      original: row.fullContentOriginal,
      cleaned: row.fullContentCleaned,
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
 * Strips internal fields, sanitizes content, and defaults fetchFullContent.
 */
export async function toFullEntry(row: NonNullable<Awaited<ReturnType<typeof selectFullEntry>>>) {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    contentHash,
    contentOriginal,
    contentCleaned,
    fullContentOriginal,
    fullContentCleaned,
    ...rest
  } = row;

  const content = await sanitizeFullEntryContent({
    contentOriginal,
    contentCleaned,
    fullContentOriginal,
    fullContentCleaned,
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

/**
 * {@link toFullEntry} for many ids at once (the native app's offline download).
 * Ids the user can't see are skipped; order follows the input.
 */
export async function getFullEntries(db: typeof dbType, userId: string, entryIds: string[]) {
  if (entryIds.length === 0) return [];
  const rows = await selectFullEntryRows(
    db,
    and(inArray(visibleEntries.id, entryIds), eq(visibleEntries.userId, userId))
  );
  const mapped = await mapWithConcurrency(rows, GET_ENTRIES_SANITIZE_CONCURRENCY, (row) =>
    toFullEntry(row)
  );
  const byId = new Map(mapped.map((entry) => [entry.id, entry]));
  return entryIds.flatMap((id) => byId.get(id) ?? []);
}

export interface ExportableEntry {
  id: string;
  type: "web" | "email" | "saved";
  url: string | null;
  title: string | null;
  author: string | null;
  siteName: string | null;
  /** The subscription's name for the feed; null for saved articles. */
  feedTitle: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  read: boolean;
  starred: boolean;
  /** The sanitized body the entry view shows by default. */
  contentHtml: string | null;
}

/**
 * The fetched full article, for reads that serve the variant the entry view
 * shows rather than both families. Needs `subscriptions` LEFT JOINed on the
 * entry's subscription. The body is raw (untrusted) and loaded only for
 * subscriptions that fetch full content, reduced to the variant served so a
 * whole-page original is never loaded alongside its cleaned version.
 */
const shownFullContentSelectFields = {
  fullContent: sql<
    string | null
  >`CASE WHEN ${subscriptions.fetchFullContent} THEN COALESCE(${visibleEntries.fullContentCleaned}, ${visibleEntries.fullContentOriginal}) END`,
  fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
  fullContentError: visibleEntries.fullContentError,
  fetchFullContent: subscriptions.fetchFullContent,
};

interface ShownFullContentFields {
  fullContent: string | null;
  fullContentFetchedAt: Date | null;
  fullContentError: string | null;
  fetchFullContent: boolean | null;
}

/**
 * Splits a row selected with `shownFullContentSelectFields` into the raw full
 * content the entry view shows (null when it shows feed content, per
 * `showsFullContent`) and the rest of the row.
 */
function takeShownFullContent<T extends ShownFullContentFields>(
  row: T
): [string | null, Omit<T, keyof ShownFullContentFields>] {
  const { fullContent, fullContentFetchedAt, fullContentError, fetchFullContent, ...rest } = row;
  const shown = showsFullContent({
    fullContentCleaned: fullContent,
    fullContentFetchedAt,
    fullContentError,
    fetchFullContent,
  });
  return [shown ? fullContent : null, rest];
}

/**
 * One page of the entries an account export keeps (`library-export.ts`): saved
 * and uploaded articles, newsletter issues, and starred entries of any type,
 * limited like every read to what `visible_entries` shows. Pages are keyed on
 * entry id; pass the previous page's `nextAfterId` until it comes back null.
 *
 * The page's ids come from `user_entries` directly so its primary key bounds
 * each page's scan (a range predicate on the view's id doesn't reach it); a
 * page can hold fewer entries than `limit` when some aren't visible.
 */
export async function listExportableEntries(
  db: typeof dbType,
  userId: string,
  { afterId, limit }: { afterId: string | null; limit: number }
): Promise<{ entries: ExportableEntry[]; nextAfterId: string | null }> {
  const idRows = await db
    .select({ id: userEntries.entryId })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .where(
      and(
        eq(userEntries.userId, userId),
        afterId ? gt(userEntries.entryId, afterId) : undefined,
        or(
          eq(userEntries.starred, true),
          and(inArray(entries.type, ["saved", "email"]), eq(entries.isSpam, false))
        )
      )
    )
    .orderBy(asc(userEntries.entryId))
    .limit(limit);
  if (idRows.length === 0) return { entries: [], nextAfterId: null };

  // Feed content is reduced to the variant the view shows by default (cleaned,
  // falling back to original), like full content.
  const rows = await db
    .select({
      id: visibleEntries.id,
      type: visibleEntries.type,
      url: visibleEntries.url,
      title: visibleEntries.title,
      author: visibleEntries.author,
      siteName: visibleEntries.siteName,
      feedTitle: sql<
        string | null
      >`CASE WHEN ${visibleEntries.type} = 'saved' THEN NULL ELSE ${entryFeedTitleSql()} END`,
      summary: visibleEntries.summary,
      publishedAt: visibleEntries.publishedAt,
      fetchedAt: visibleEntries.fetchedAt,
      read: visibleEntries.read,
      starred: visibleEntries.starred,
      content: sql<
        string | null
      >`COALESCE(${visibleEntries.contentCleaned}, ${visibleEntries.contentOriginal})`,
      ...shownFullContentSelectFields,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .leftJoin(subscriptions, entrySubscriptionJoin(visibleEntries))
    .where(
      and(
        eq(visibleEntries.userId, userId),
        inArray(
          visibleEntries.id,
          idRows.map((row) => row.id)
        )
      )
    )
    .orderBy(asc(visibleEntries.id));

  const exportable = await mapWithConcurrency(
    rows,
    GET_ENTRIES_SANITIZE_CONCURRENCY,
    async (row) => {
      const [fullContent, { content, ...rest }] = takeShownFullContent(row);
      return { ...rest, contentHtml: await sanitizeEntryHtmlAsync(fullContent ?? content) };
    }
  );

  return {
    entries: exportable,
    nextAfterId: idRows.length < limit ? null : idRows[idRows.length - 1].id,
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

  // If query is provided, delegate to search implementation (indexed full-text
  // search over the stored entries.search_vector column — see searchEntries).
  if (params.query) {
    return searchEntries(db, {
      ...params,
      query: params.query,
      showSpam: params.showSpam,
    });
  }

  const effectiveMaxLimit = params.maxLimit ?? MAX_LIMIT;
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, effectiveMaxLimit);
  const sortOrder = params.sortOrder ?? "newest";

  const conditions = [eq(visibleEntries.userId, params.userId)];

  // Apply subscription filters (subscriptionId, tagId, uncategorized)
  const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, params.userId);
  if (subscriptionFilter === null) {
    return { items: [], nextCursor: undefined };
  }
  if (subscriptionFilter) {
    conditions.push(subscriptionFilter);
  }

  // Apply entry filter conditions (read/starred/type/spam/timestamp filters)
  conditions.push(...buildEntryFilterConditions(params));

  // Recently Read: exclude entries that were never explicitly read-state-changed.
  // This exclusion is specific to that view (sortBy=readChanged); the Wallabag
  // "archived" sort orders by the same column but keeps unarchived entries.
  if (params.sortBy === "readChanged") {
    conditions.push(isNotNull(visibleEntries.readChangedAt));
  }

  // Sort column (all choices are served by an existing index):
  //  - "published" (default) uses the denormalized user_entries sort key so the
  //    planner can serve filter + sort from idx_user_entries_published_or_fetched.
  //  - "readChanged"/"archived" sort by when read state was last changed
  //    (idx_user_entries_read_changed_at).
  const sortColumn =
    params.sortBy === "readChanged" || params.sortBy === "archived"
      ? visibleEntries.readChangedAt
      : visibleEntries.publishedOrFetchedAt;

  // Full-precision sort key for cursor encoding. The pool hands back Postgres's
  // raw microsecond string for timestamptz (see parseTimestamptz); mapWith decodes
  // it to a Temporal.Instant so the cursor never loses the microseconds a JS Date
  // would truncate — which corrupted keyset pagination (#680, #683).
  //
  // Null-tolerant: the "archived" sort (Wallabag) orders by readChangedAt WITHOUT
  // the readChanged view's isNotNull filter, so a row can have a null sort key.
  // That path is offset-paginated and ignores nextCursor, but the decoder still
  // runs on every row — matching the old to_char(NULL) → NULL behaviour. For the
  // cursor-paginated sorts (published is NOT NULL; readChanged filters non-null)
  // the sort key is always present.
  const sortTsInstant = sql`${sortColumn}`.mapWith(parseTimestamptzOrNull);

  // Cursor condition
  // Pass timestamp string directly to Postgres (::timestamptz) to preserve
  // microsecond precision. Using new Date(ts) would truncate to milliseconds,
  // causing entries to fall into gaps between cursor and actual timestamps.
  if (params.cursor) {
    const { ts, id } = timelineCursor.decode(params.cursor);
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
      ...entryListSelectFields,
      feedTitle: entryFeedTitleSql(),
      sortTs: sortTsInstant,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .leftJoin(subscriptions, entrySubscriptionJoin(visibleEntries))
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
    // sortTs is only null for the offset-paginated "archived" sort (which ignores
    // nextCursor); the cursor-paginated sorts always have a non-null sort key.
    if (lastEntry.sortTs) {
      nextCursor = timelineCursor.encode({ ts: lastEntry.sortTs.toString(), id: lastEntry.id });
    }
  }

  return { items, nextCursor };
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
  const effectiveMaxLimit = params.maxLimit ?? MAX_LIMIT;
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
  const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, params.userId);
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
      // Alias to avoid colliding with visibleEntries.title (both are "title")
      // inside the subquery, which would make the outer reference ambiguous.
      feedTitle: entryFeedTitleSql().as("feed_title"),
      // Alias required so the outer query can reference this raw SQL field.
      rank: rankColumn.as("rank"),
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .leftJoin(subscriptions, entrySubscriptionJoin(visibleEntries))
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
 * Maps a raw row to EntryFull, sanitizing the content family per read. Full
 * content is sanitized only when it's the variant shown.
 */
async function toEntryFull(
  row: Awaited<ReturnType<typeof selectEntryFullRows>>[number]
): Promise<EntryFull> {
  const [fullContent, { contentOriginal, contentCleaned, ...rest }] = takeShownFullContent(row);

  const [content, sanitizedFullContent] = await Promise.all([
    sanitizeEntryContentFamily("content", {
      original: contentOriginal,
      cleaned: contentCleaned,
    }),
    sanitizeEntryHtmlAsync(fullContent),
  ]);

  return {
    ...rest,
    contentOriginal: content.original,
    contentCleaned: content.cleaned,
    fullContent: sanitizedFullContent,
  };
}

function selectEntryFullRows(db: typeof dbType, condition: SQL | undefined) {
  return db
    .select({
      ...entryFullSelectFields,
      ...shownFullContentSelectFields,
    })
    .from(visibleEntries)
    .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
    .leftJoin(subscriptions, entrySubscriptionJoin(visibleEntries))
    .where(condition);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * input order in the result. Used to bound how many entry bodies sanitize
 * concurrently on batch reads (see getEntries).
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * The largest read batch is the Google Reader stream-contents sync, up to ~100
 * entries. Sanitization is native and fast (~0.09 ms / 10 KB, off the event loop
 * for large bodies), but this caps how many bodies are in flight at once so a
 * batch of large bodies can't flood the libuv pool or spike memory.
 */
const GET_ENTRIES_SANITIZE_CONCURRENCY = 8;

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

  return toEntryFull(result[0]);
}

/**
 * Gets multiple entries by ID in a single query.
 * Returns entries in the same order as the input IDs.
 * Missing entries are silently skipped.
 * Content fields are sanitized per read (see getEntry).
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

  // Build a map for O(1) lookup, then return in original order. Sanitize with a
  // small concurrency bound so a large-body batch doesn't flood the thread pool.
  const mapped = await mapWithConcurrency(results, GET_ENTRIES_SANITIZE_CONCURRENCY, (row) =>
    toEntryFull(row)
  );
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
      readChangedAt: visibleEntries.readChangedAt,
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
    publishMarkReadStateChanges(db, userId, changed, counts);
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
): Promise<{ entryIds: string[]; counts?: BulkUnreadCounts }> {
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

  // Filter by subscriptionId: a foreign or unsubscribed subscription matches
  // nothing. (Scoping checks query the subscriptions table, never the
  // display-only user_feeds view.)
  const columns = { entryId: userEntries.entryId, subscriptionId: userEntries.subscriptionId };
  if (params.subscriptionId) {
    if (!(await verifySubscriptionOwnership(db, params.subscriptionId, params.userId))) {
      return { entryIds: [] };
    }
    conditions.push(
      await buildEntriesInSubscriptionsCondition(
        db,
        params.userId,
        [params.subscriptionId],
        columns
      )
    );
  }

  // Filter by tag (ownership enforced by the shared subquery's tags.userId join)
  if (params.tagId) {
    conditions.push(
      await buildEntriesInSubscriptionsCondition(
        db,
        params.userId,
        buildTaggedSubscriptionIdsSubquery(db, params.tagId, params.userId),
        columns
      )
    );
  }

  // Filter by uncategorized (no tags). Reuse the shared subquery builder so this
  // stays in sync with buildEntrySubscriptionFilter (listEntries/countEntries).
  if (params.uncategorized) {
    conditions.push(
      await buildEntriesInSubscriptionsCondition(
        db,
        params.userId,
        buildUncategorizedSubscriptionIdsSubquery(db, params.userId),
        columns
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
    .returning({ id: userEntries.entryId, subscriptionId: userEntries.subscriptionId });

  const entryIds = result.map((r) => r.id);
  if (entryIds.length === 0) return { entryIds };
  // Absolute counts for every list the marked entries reached, so clients
  // set them rather than refetching and guessing which lists went to zero.
  const counts = await getBulkEntryRelatedCounts(db, params.userId, result);

  // Notify the user's other tabs/devices. Mark-all-read is unbounded, so rather
  // than emitting a per-entry event (or shipping every affected id), we publish
  // one signal with the counts and let each connection invalidate its entry
  // lists — the same thing the acting tab already does on success. Published
  // here (not in the router) so every caller — the tRPC mutation and the Google
  // Reader mark-all-as-read route — notifies other tabs. Fire and forget.
  //
  // This publishes after the (autocommitted) UPDATE above completes. Today's
  // callers pass the global `db`, so that's always post-commit. If a future
  // caller runs this inside a transaction, move the publish to after the commit
  // so a rolled-back mark-all-read can't emit a phantom event.
  //
  // The largest marked entry id rides along so the client's entries keyset
  // cursor lands exactly past the marked rows rather than past the whole
  // tied-timestamp group: an unrelated entry written in the same millisecond
  // as `updatedAt` has a UUIDv7 id above every earlier-created marked entry
  // (the ordering comes from the UUIDv7 ms-timestamp prefix; marked entries
  // exist before the mark-all-read), so a catch-up sync can still deliver it
  // if its live event was missed (#1102). UUIDs are lowercase, so string
  // comparison matches Postgres uuid ordering.
  const maxEntryId = entryIds.reduce((max, id) => (id > max ? id : max));
  void publishMarkAllRead(params.userId, updatedAt, maxEntryId, counts).catch(() => {
    // Ignore publish errors - SSE is best-effort
  });

  return { entryIds, counts };
}

/**
 * Reads back the post-update state of star-mutated entries from `user_entries`
 * rather than from `visible_entries`.
 *
 * A star write is the one entry mutation that can change an entry's own
 * **visibility**: `visible_entries` keeps a starred entry from an unsubscribed
 * subscription visible (the starred-orphan arm of its predicate), so unstarring
 * one drops it straight out of the view. Reading the result back through the
 * view therefore saw zero rows for a write that had just landed — the single
 * path raised `entryNotFound` and the bulk path silently returned nothing, so
 * in both cases the counts and the `entry_state_changed` publish were skipped
 * and the user's tabs kept a stale star and stale badges.
 *
 * The `user_entries` row is the durable record of visibility (see "Entry
 * Visibility" in `src/server/CLAUDE.md`), so its existence is the same
 * not-found signal, and it does not move when the star does. The `user_id`
 * predicate keeps the read scoped to the caller, so another user's entry id
 * still matches no row.
 *
 * The projected columns are exactly what the view computes: it emits
 * `GREATEST(entries.updated_at, user_entries.updated_at)` as `updated_at`, and
 * its `subscription_id` is `subscriptions.id` from a LEFT JOIN on
 * `user_entries.subscription_id` — whose FK is `ON DELETE SET NULL`, so the
 * column is NULL in exactly the cases the join would produce NULL.
 */
async function selectStarredEntryStates(
  db: DbOrTx,
  userId: string,
  entryIds: string[]
): Promise<MarkReadEntryState[]> {
  return db
    .select({
      id: userEntries.entryId,
      subscriptionId: userEntries.subscriptionId,
      read: userEntries.read,
      starred: userEntries.starred,
      type: entries.type,
      updatedAt: sql`GREATEST(${entries.updatedAt}, ${userEntries.updatedAt})`.mapWith(
        userEntries.updatedAt
      ),
      readChangedAt: userEntries.readChangedAt,
    })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .where(and(eq(userEntries.userId, userId), inArray(userEntries.entryId, entryIds)));
}

/**
 * Stars or unstars a single entry: {@link updateEntriesStarred} for one id,
 * returning its final state (`counts` absent unless the value flipped).
 *
 * @throws entryNotFound when the user has no such entry
 */
export async function updateEntryStarred(
  db: DbOrTx,
  userId: string,
  entryId: string,
  starred: boolean,
  changedAt: Date = new Date()
): Promise<{ entry: EntryState; counts?: BulkUnreadCounts }> {
  const result = await updateEntriesStarred(db, userId, [{ id: entryId, changedAt }], starred);
  const row = result.entries[0];
  if (!row) {
    throw errors.entryNotFound();
  }

  // Narrow to EntryState rather than passing the row through: the shared
  // read-back also carries `subscriptionId`/`type`, which this function's
  // callers (tRPC, MCP, Wallabag) serialize straight to the client.
  const entry: EntryState = {
    id: row.id,
    read: row.read,
    starred: row.starred,
    updatedAt: row.updatedAt,
  };
  return { entry, counts: result.counts };
}

/**
 * Stars or unstars entries, applying a single starred value to many entries in
 * one `UPDATE ... FROM` instead of issuing one statement per entry (the Google
 * Reader `edit-tag` endpoint can carry up to 1000 item ids in a single call,
 * issue #1266).
 *
 * Uses idempotent updates: only applies if changedAt is newer than the stored
 * starred_changed_at timestamp. This prevents stale updates from overwriting
 * newer state.
 *
 * A row being written is not the same as the starred value changing (issue
 * #1118): re-asserting a state the entry already has still writes the row to
 * advance the `starred_changed_at` last-write-wins watermark — dropping that
 * write would let an older conflicting update win later — but the count
 * aggregation runs and the SSE event publishes only for entries whose value
 * actually flipped. `counts` is undefined when nothing flipped; callers treat
 * "no counts" as "counts didn't change". Mirrors {@link markEntriesRead}: a
 * self-join on `prev` captures each row's pre-update starred value in the same
 * statement (RETURNING only sees new values before PG 18's `old.*`), avoiding a
 * pre-SELECT's TOCTOU window; `updated_at` (the delta-sync "meaningful change"
 * timestamp) advances only on a real flip, so a same-value re-assert never
 * re-delivers the entry to offline/polling clients.
 *
 * Counts are computed once here and both returned and published, so callers
 * don't re-query them. Publishing `entry_state_changed` lives here — not at
 * each API boundary — so every surface (tRPC, MCP, Google Reader, Wallabag)
 * notifies the user's other tabs/devices for free. Fire and forget.
 *
 * This publishes after the (autocommitted) UPDATE completes. Today's callers
 * pass the global `db`, so that's always post-commit. If a future caller runs
 * this inside a transaction, move the publish to after the commit so a
 * rolled-back change can't emit a phantom event.
 *
 * @param changedAt - When the user initiated the action. Defaults to now.
 */
export async function updateEntriesStarred(
  db: DbOrTx,
  userId: string,
  entriesToStar: MarkReadEntry[],
  starred: boolean
): Promise<{
  entries: MarkReadEntryState[];
  changed: MarkReadEntryState[];
  counts?: BulkUnreadCounts;
}> {
  if (entriesToStar.length === 0) {
    return { entries: [], changed: [] };
  }

  if (entriesToStar.length > 1000) {
    throw errors.validation("Maximum 1000 entries per request");
  }

  const now = new Date();

  // Per-entry timestamps in one UPDATE ... FROM (VALUES ...), with the same
  // `prev` self-join and watermark semantics as markEntriesRead.
  const rows = entriesToStar.map(
    (entry) => sql`(${entry.id}::uuid, ${(entry.changedAt ?? now).toISOString()}::timestamptz)`
  );
  const updated = await db.execute<{ entry_id: string; old_starred: boolean }>(sql`
    UPDATE user_entries AS ue
    SET starred = ${starred},
        starred_changed_at = v.ts,
        updated_at = CASE WHEN prev.starred <> ${starred} THEN ${now} ELSE ue.updated_at END
    FROM (VALUES ${sql.join(rows, sql`, `)}) AS v(entry_id, ts)
    JOIN user_entries AS prev
      ON prev.user_id = ${userId}::uuid
      AND prev.entry_id = v.entry_id
    WHERE ue.user_id = ${userId}::uuid
      AND ue.entry_id = v.entry_id
      AND ue.starred_changed_at <= v.ts
    RETURNING ue.entry_id AS entry_id, prev.starred AS old_starred
  `);
  const flippedIds = new Set(
    updated.rows.filter((row) => row.old_starred !== starred).map((row) => row.entry_id)
  );

  // Resolved from `user_entries`, not `visible_entries`: unstarring an orphan
  // drops it out of the view, and a silently empty read-back here would skip
  // the counts and the SSE publish (see selectStarredEntryStates).
  const entriesState = await selectStarredEntryStates(
    db,
    userId,
    entriesToStar.map((entry) => entry.id)
  );

  // Only entries whose starred value actually flipped warrant SSE events and
  // count recomputation (issue #1118); a batch of pure re-asserts still
  // advanced the watermark above but changes no count.
  const changed = entriesState.filter((entry) => flippedIds.has(entry.id));
  const counts =
    changed.length > 0 ? await getBulkEntryRelatedCounts(db, userId, changed) : undefined;

  if (changed.length > 0 && counts) {
    publishStarredStateChanges(userId, changed, counts);
  }

  return { entries: entriesState, changed, counts };
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
  const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, userId);
  if (subscriptionFilter === null) {
    return { unread: 0 };
  }
  if (subscriptionFilter) {
    conditions.push(subscriptionFilter);
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

  const subscriptionFilter = await buildEntrySubscriptionFilter(db, params, userId);
  if (subscriptionFilter === null) {
    return 0;
  }
  if (subscriptionFilter) {
    conditions.push(subscriptionFilter);
  }

  conditions.push(...buildEntryFilterConditions(params));

  // One row per (user, entry), so count(*) is exact (see countEntries).
  const result = await db
    .select({
      total: sql<number>`count(*)::int`,
    })
    .from(visibleEntries)
    .where(and(...conditions));

  return result[0]?.total ?? 0;
}
