/**
 * Reads of whole entries by id (the app's entry view, the external APIs'
 * entries, the AI paths' raw content) and the account export's pages. Every
 * read sanitizes the content it returns except `getOwnedEntryRawContent`.
 */

import { z } from "zod";
import { eq, and, asc, inArray, gt, sql, or, type SQL } from "drizzle-orm";
import type { db as dbType } from "@/server/db";
import { entries, feeds, subscriptions, userEntries, visibleEntries } from "@/server/db/schema";
import { sanitizeEntryContentPair } from "@/server/html/sanitize-entry";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
import { selectDisplayedContent, showsFullContent } from "@/lib/entry-content";
import { escapeHtml } from "@/server/http/html";
import { errors } from "@/server/errors";
import {
  entryFeedTitleSql,
  entryOriginOn,
  VISIBLE_MEMBERSHIPS,
  VISIBLE_ROW,
} from "./entry-filters";
import type { EntryType } from "@/lib/entry-types";
import { entryListItemSchema } from "./entries";
import { withTagLists } from "./entry-tag-lists";
import type { TagLists } from "@/lib/events/schemas";

/**
 * The app's full-entry view (`entries.get`). Every content field is the
 * sanitized version of the stored content: raw feed HTML never leaves the
 * service layer.
 */
export const fullEntrySchema = entryListItemSchema.extend({
  contentOriginal: z.string().nullable(),
  contentCleaned: z.string().nullable(),
  feedUrl: z.string().nullable(),
  /** The unsubscribe link from an email's HTML. */
  unsubscribeUrl: z.string().nullable(),
  fullContentCleaned: z.string().nullable(),
  fullContentFetchedAt: z.date().nullable(),
  fullContentError: z.string().nullable(),
  /** The subscription's setting, so the entry view needs no `subscriptions.get`. */
  fetchFullContent: z.boolean(),
});

export type FullEntry = z.infer<typeof fullEntrySchema>;

/**
 * The native app's offline entry (`entries.getMany`): the full entry plus
 * `content`, the body a reader without content toggles shows
 * ({@link defaultShownContent}), so the app doesn't copy the web's choice.
 */
export const offlineEntrySchema = fullEntrySchema.extend({
  content: z.string().nullable(),
});

type OfflineEntry = z.infer<typeof offlineEntrySchema>;

/**
 * The external APIs' full entry (MCP, Google Reader, Wallabag): the app's,
 * with only the full content the entry view shows.
 */
export type EntryFull = Omit<
  FullEntry,
  "fullContentCleaned" | "fullContentFetchedAt" | "fullContentError" | "fetchFullContent"
> & {
  /**
   * The sanitized fetched full article when the entry view shows it instead of
   * the feed content (`showsFullContent`), else null. External clients serve
   * this first so they match the web app.
   */
  fullContent: string | null;
};

/**
 * Every full-entry read selects these and maps them to its output shape
 * (`toFullEntry` for the app's entry view, `toEntryFull` for the external
 * APIs). The content columns are **raw** (untrusted): both mappers sanitize
 * them, so raw feed HTML never leaves this service.
 */
const entryReadSelectFields = {
  id: visibleEntries.id,
  type: visibleEntries.type,
  url: visibleEntries.url,
  title: visibleEntries.title,
  author: visibleEntries.author,
  contentOriginal: visibleEntries.contentOriginal,
  contentCleaned: visibleEntries.contentCleaned,
  fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
  fullContentError: visibleEntries.fullContentError,
  summary: visibleEntries.summary,
  publishedAt: visibleEntries.publishedAt,
  fetchedAt: visibleEntries.fetchedAt,
  read: visibleEntries.read,
  starred: visibleEntries.starred,
  readChangedAt: visibleEntries.readChangedAt,
  score: visibleEntries.score,
  updatedAt: visibleEntries.updatedAt,
  entryUpdatedAt: visibleEntries.entryUpdatedAt,
  contentHash: visibleEntries.contentHash,
  subscriptionId: subscriptions.id,
  subscriptionIds: VISIBLE_MEMBERSHIPS.subscriptionIds,
  positions: VISIBLE_MEMBERSHIPS.positions,
  fetchFullContent: subscriptions.fetchFullContent,
  siteName: visibleEntries.siteName,
  feedTitle: entryFeedTitleSql(),
  feedUrl: feeds.url,
  unsubscribeUrl: visibleEntries.unsubscribeUrl,
};

/**
 * Which fetched full articles a read loads: all of them (the app's entry view
 * can toggle between full and feed content), or only those the entry view
 * shows by default, for reads that serve just that variant. The bodies sit on
 * the shared entry row, so another subscriber's fetch fills them in either
 * way.
 */
type FullContentScope = "all" | "shown";

/**
 * The full article, raw. A plugin fetch from before 4d18f516 stored its
 * article only as the original, which the backfill of #2115 moves into
 * `full_content_cleaned`; until it has run, fall back to it.
 */
const fullContentArticleSql = sql<
  string | null
>`COALESCE(${visibleEntries.fullContentCleaned}, ${visibleEntries.fullContentOriginal})`;

/** The full-content body, raw. */
function fullContentBodyFields(scope: FullContentScope) {
  const loaded = scope === "all" ? sql`true` : sql`${subscriptions.fetchFullContent}`;
  return {
    fullContentCleaned: sql<string | null>`CASE WHEN ${loaded} THEN ${fullContentArticleSql} END`,
  };
}

function selectEntryRows(db: typeof dbType, where: SQL | undefined, scope: FullContentScope) {
  return db
    .select({ ...entryReadSelectFields, ...fullContentBodyFields(scope) })
    .from(visibleEntries)
    .leftJoin(feeds, eq(visibleEntries.ownerFeedId, feeds.id))
    .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
    .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
    .where(where);
}

type EntryRow = Awaited<ReturnType<typeof selectEntryRows>>[number] & { tagLists: TagLists };

/**
 * Reads the user's visible entries among `entryIds` and maps each to an output
 * shape, in input order, skipping ids the user can't see. Mapping sanitizes,
 * so it runs with a small concurrency bound: a batch of large bodies mustn't
 * flood the thread pool.
 */
async function readEntries<T extends { id: string }>(
  db: typeof dbType,
  userId: string,
  entryIds: string[],
  scope: FullContentScope,
  toOutput: (row: EntryRow) => Promise<T>
): Promise<T[]> {
  if (entryIds.length === 0) return [];
  const rows = await withTagLists(
    db,
    userId,
    entryIds,
    selectEntryRows(
      db,
      and(inArray(visibleEntries.id, entryIds), eq(visibleEntries.userId, userId)),
      scope
    )
  );
  const mapped = await mapWithConcurrency(rows, GET_ENTRIES_SANITIZE_CONCURRENCY, toOutput);
  const byId = new Map(mapped.map((entry) => [entry.id, entry]));
  return entryIds.flatMap((id) => byId.get(id) ?? []);
}

/** Like {@link readEntries} for one entry. @throws entryNotFound */
async function readEntry<T>(
  db: typeof dbType,
  userId: string,
  entryId: string,
  scope: FullContentScope,
  toOutput: (row: EntryRow) => Promise<T>
): Promise<T> {
  const [row] = await withTagLists(
    db,
    userId,
    [entryId],
    selectEntryRows(
      db,
      and(eq(visibleEntries.id, entryId), eq(visibleEntries.userId, userId)),
      scope
    ).limit(1)
  );
  if (!row) {
    throw errors.entryNotFound();
  }
  return toOutput(row);
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
  fullContentCleaned: fullContentArticleSql,
  fullContentHash: visibleEntries.fullContentHash,
};

export interface OwnedEntryRawContent {
  title: string | null;
  contentOriginal: string | null;
  contentCleaned: string | null;
  contentHash: string;
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
 * The app's full-entry view of a row: the feed content pair and the full
 * content sanitized (the view can toggle back to feed content).
 */
async function toFullEntry(row: EntryRow): Promise<FullEntry> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { contentHash, contentOriginal, contentCleaned, fullContentCleaned, ...rest } = row;

  const [content, sanitizedFullContent] = await Promise.all([
    sanitizeEntryContentPair({ original: contentOriginal, cleaned: contentCleaned }),
    sanitizeEntryHtmlAsync(fullContentCleaned),
  ]);

  return {
    ...rest,
    contentOriginal: content.original,
    contentCleaned: content.cleaned,
    fullContentCleaned: sanitizedFullContent,
    fetchFullContent: row.fetchFullContent ?? false,
  };
}

/**
 * One entry in the app's full-entry view (`entries.get`), plus its content
 * hash, which keys caches built from the content (narration) but isn't shown.
 *
 * @throws entryNotFound if the entry doesn't exist or isn't visible to the user
 */
export async function getFullEntry(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<{ entry: FullEntry; contentHash: string }> {
  return readEntry(db, userId, entryId, "all", async (row) => ({
    entry: await toFullEntry(row),
    contentHash: row.contentHash,
  }));
}

/**
 * What the entry view shows before any toggle, as sanitized HTML: the variant
 * `selectDisplayedContent` picks (full content when `showsFullContent`, never
 * "show original"), or failing that (none, or empty) the summary as a
 * paragraph of text, as `EntryContentRenderer` falls back.
 */
function defaultShownContent(entry: FullEntry): string | null {
  const shown = selectDisplayedContent(entry, {
    showFullContent: showsFullContent(entry),
    showOriginal: false,
  });
  if (shown) return shown;
  return entry.summary ? `<p>${escapeHtml(entry.summary)}</p>` : null;
}

/**
 * {@link getFullEntry}'s entries for many ids at once, with the content they
 * show (the native app's offline download). Ids the user can't see are
 * skipped; order follows the input.
 */
export async function getFullEntries(
  db: typeof dbType,
  userId: string,
  entryIds: string[]
): Promise<OfflineEntry[]> {
  return readEntries(db, userId, entryIds, "all", async (row) => {
    const entry = await toFullEntry(row);
    return { ...entry, content: defaultShownContent(entry) };
  });
}

export interface ExportableEntry {
  id: string;
  type: EntryType;
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
 * The fetched full article, for reads that serve only the variant the entry
 * view shows. Needs `subscriptions` LEFT JOINed on the
 * entry's subscription. The body is raw (untrusted) and loaded only for
 * subscriptions that fetch full content.
 */
const shownFullContentSelectFields = {
  fullContent: sql<
    string | null
  >`CASE WHEN ${subscriptions.fetchFullContent} THEN ${fullContentArticleSql} END`,
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
    .leftJoin(feeds, eq(visibleEntries.ownerFeedId, feeds.id))
    .leftJoinLateral(VISIBLE_MEMBERSHIPS, sql`true`)
    .leftJoin(subscriptions, entryOriginOn(VISIBLE_MEMBERSHIPS, VISIBLE_ROW))
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

/**
 * The external APIs' view of a row (EntryFull): the feed content family
 * sanitized, and the fetched full article only when it's the variant the
 * entry view shows (`showsFullContent`).
 */
async function toEntryFull(row: EntryRow): Promise<EntryFull> {
  const shownFullContent = showsFullContent(row) ? row.fullContentCleaned : null;
  const [content, fullContent] = await Promise.all([
    sanitizeEntryContentPair({ original: row.contentOriginal, cleaned: row.contentCleaned }),
    sanitizeEntryHtmlAsync(shownFullContent),
  ]);

  return {
    id: row.id,
    subscriptionId: row.subscriptionId,
    subscriptionIds: row.subscriptionIds,
    positions: row.positions,
    tagLists: row.tagLists,
    type: row.type,
    url: row.url,
    title: row.title,
    author: row.author,
    contentOriginal: content.original,
    contentCleaned: content.cleaned,
    fullContent,
    summary: row.summary,
    publishedAt: row.publishedAt,
    fetchedAt: row.fetchedAt,
    updatedAt: row.updatedAt,
    entryUpdatedAt: row.entryUpdatedAt,
    read: row.read,
    starred: row.starred,
    readChangedAt: row.readChangedAt,
    score: row.score,
    feedTitle: row.feedTitle,
    feedUrl: row.feedUrl,
    siteName: row.siteName,
    unsubscribeUrl: row.unsubscribeUrl,
  };
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
 * Gets a single entry by ID with full content, for the external APIs (MCP,
 * Google Reader, Wallabag).
 *
 * @throws entryNotFound if the entry doesn't exist or isn't visible to the user
 */
export async function getEntry(
  db: typeof dbType,
  userId: string,
  entryId: string
): Promise<EntryFull> {
  return readEntry(db, userId, entryId, "shown", toEntryFull);
}

/**
 * {@link getEntry} for many ids in one query. Ids the user can't see are
 * skipped; order follows the input.
 */
export async function getEntries(
  db: typeof dbType,
  userId: string,
  entryIds: string[]
): Promise<EntryFull[]> {
  return readEntries(db, userId, entryIds, "shown", toEntryFull);
}
