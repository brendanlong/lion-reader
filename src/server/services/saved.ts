/**
 * Saved Articles Service
 *
 * Storing saved articles and uploads: saving a URL (and refetching it),
 * placeholders for failed saves, uploads and deletion. Fetching an article
 * and deriving its stored fields is in `saved-content.ts`.
 */

import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import type { db as dbType } from "@/server/db";
import { entries, subscriptions, userEntries } from "@/server/db/schema";
import { entryMemberships, entryOriginOn } from "./entry-filters";
import { SAVED_ARTICLES_TITLE } from "@/lib/entry-types";
import { insertUserEntriesWithMemberships } from "@/server/services/subscription-entries";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  addEntryToCollections,
  assertOwnedCollections,
  listEntryCollectionIds,
  publishEntryLeftCollections,
} from "./collections";
import { recordEntryTombstone } from "./entry-tombstones";
import { enqueueStoredObjectsDeletion, entryObjectsPrefix } from "./stored-objects";
import { normalizeUrl } from "@/lib/url";
import { processMarkdown } from "@/server/markdown";
import { detectFileType, getSupportedTypesDescription } from "@/server/file/process-upload";
import { type SupportedFileType } from "@/lib/upload-file-types";
import { usageLimitsConfig } from "@/server/config/env";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
import { stripHtml } from "@/server/html/strip-html";
import { escapeHtml } from "@/server/http/html";
import { sanitizeEntryContentFamily } from "@/server/html/sanitize-entry";
import { logger } from "@/lib/logger";
import { publishUserEvent } from "@/server/redis/pubsub";
import { toEntryMetadata } from "@/server/services/entry-sync-events";
import { toNewEntryListData, type NewEntryListItem } from "@/lib/events/schemas";
import { errors } from "@/server/errors";
import { finishEntriesRead, writeEntriesRead } from "@/server/services/entry-state";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import { normalizeSavedArticleUrl, type UserAuthMode } from "@/server/plugins";
import {
  acquireSavedArticleContent,
  buildArticleFields,
  convertUpload,
  generateContentHash,
  type BuiltArticleFields,
} from "./saved-content";

// ============================================================================
// Types
// ============================================================================

interface CollectionsParam {
  /** The user's collections to file the new article into ({@link withCollections}). */
  collectionIds?: string[];
}

export interface SaveArticleParams extends CollectionsParam {
  url: string;
  /** Optional title hint (useful when page title is poor) */
  title?: string;
  /**
   * Optional author hint. Highest-precedence author source (above plugin /
   * frontmatter / Readability / OG-meta), for a caller that already knows the
   * byline better than our extraction. Plain text (rendered escaped).
   */
  author?: string;
  /**
   * Optional excerpt/summary hint. Highest-precedence excerpt source (above the
   * plugin excerpt / frontmatter / Readability), for a caller that already has a
   * clean summary in hand. Plain text (rendered escaped); clipped to the summary
   * length like the other excerpt sources.
   */
  excerpt?: string;
  /**
   * Pre-fetched HTML (e.g. a bookmarklet capturing the rendered DOM). Used
   * instead of fetching the URL — useful for JavaScript-rendered pages where
   * a server-side fetch would miss content.
   */
  html?: string;
  /**
   * When true, re-fetch and update the article if the URL is already saved.
   * When omitted here, the existing article is returned without refetching —
   * but note the tRPC/REST `saved.save` endpoint defaults this to `true`, so
   * that surface refetches by default (MCP and other direct callers do not).
   */
  refetch?: boolean;
  /** With refetch, update even if the new content appears lower quality. */
  force?: boolean;
  /**
   * Let plugins fetch with the user's stored credentials for the source when
   * the public fetch doesn't produce the article (a private Google Doc through
   * the user's linked Google account). Both modes attempt exactly the same
   * fetch; they differ only in how they report "auth isn't set up yet"
   * ({@link UserAuthMode}).
   *
   * Leave undefined for callers that shouldn't attempt it at all; they fall
   * back to a plain HTML fetch.
   */
  userAuth?: UserAuthMode;
}

/** How a saveArticle call resolved. */
export type SaveArticleOutcome = "created" | "updated" | "existing";

export interface SaveArticleResult extends SavedArticle {
  outcome: SaveArticleOutcome;
}

export interface UploadArticleParams extends CollectionsParam {
  /** Article content in Markdown format */
  content: string;
  /** Article title */
  title: string;
  /**
   * Optional author hint. Highest-precedence author source (above the Markdown
   * frontmatter author). Plain text.
   */
  author?: string;
  /**
   * Optional excerpt/summary hint. Highest-precedence excerpt source (above the
   * Markdown frontmatter summary / cleaned content). Plain text; clipped to the
   * summary length like the other excerpt sources.
   */
  excerpt?: string;
  /**
   * Leaves relative URLs as written, so root-relative ones stay in-app links:
   * only for content we wrote ourselves (the Getting Started article). Never
   * caller-supplied: otherwise they resolve against a host that never resolves.
   */
  keepRelativeUrls?: boolean;
  /** As {@link UploadFileParams.idempotencyKey}, but the existing article isn't re-rendered. */
  idempotencyKey?: string;
}

/**
 * A saved article's metadata: what the app's save and upload endpoints return.
 * They omit the body because every render goes through `entries.get`, so
 * echoing it would only invite a caller to render it directly (#927).
 */
export const savedArticleMetadataSchema = z.object({
  id: z.string(),
  /** Null for uploaded content. */
  url: z.string().nullable(),
  title: z.string().nullable(),
  siteName: z.string().nullable(),
  author: z.string().nullable(),
  imageUrl: z.string().nullable(),
  excerpt: z.string().nullable(),
  read: z.boolean(),
  starred: z.boolean(),
  savedAt: z.date(),
});

export type SavedArticle = z.infer<typeof savedArticleMetadataSchema> & {
  /**
   * Sanitized article body. The Wallabag POST response sends it to clients as
   * `content` (via `formatSavedArticle`), so raw fetched HTML must never appear
   * here.
   */
  contentCleaned: string | null;
};

/**
 * A newly inserted saved article, with the list item its `new_entry` event
 * carries, for a caller that places it in its own lists.
 */
export interface InsertedSavedArticle {
  article: SavedArticle;
  listItem: NewEntryListItem;
}

// ============================================================================
// Shared Insert Helper
// ============================================================================

interface InsertSavedEntryParams {
  /** The entry's id, when the caller needed it before saving (to key its stored images). */
  id?: string;
  guid: string;
  url: string | null;
  title: string | null;
  author: string | null;
  contentOriginal: string;
  contentCleaned: string | null;
  summary: string | null;
  siteName: string | null;
  imageUrl: string | null;
  contentHash: string;
  /** True for a failed-save placeholder entry (see savePlaceholderArticle). */
  isPlaceholder?: boolean;
}

/**
 * Insert a saved entry into the database and publish a new-entry event.
 *
 * Handles the shared boilerplate for the URL-save path (saveArticle /
 * savePlaceholderArticle) and the upload path (insertUploadedArticle): entry
 * insert, user_entries insert, SSE publish, and SavedArticle construction.
 *
 * The entry and user_entries inserts run in one transaction so a crash can't
 * leave an entry with no user_entries row (which would make it invisible).
 *
 * Returns null when the entry already exists — the entry insert uses
 * `onConflictDoNothing` (a duplicate `(owner_user_id, guid)`), so a concurrent
 * duplicate save (e.g. a double-click) is idempotent instead of surfacing a raw
 * unique-violation 500 (issue #952). The caller re-selects the existing article
 * in that case: for an upload, one saved under the same idempotency key.
 */
async function insertSavedEntry(
  db: typeof dbType,
  userId: string,
  params: InsertSavedEntryParams
): Promise<InsertedSavedArticle | null> {
  const now = new Date();
  const entryId = params.id ?? generateUuidv7();

  // Store only the raw columns; the read path sanitizes per read (issue #1282).
  // Saved articles and uploads are owned by the user (#1846).
  const values = {
    id: entryId,
    ownerUserId: userId,
    type: "saved" as const,
    guid: params.guid,
    url: params.url,
    title: params.title,
    author: params.author,
    contentOriginal: params.contentOriginal,
    contentCleaned: params.contentCleaned,
    summary: params.summary,
    siteName: params.siteName,
    imageUrl: params.imageUrl,
    isPlaceholder: params.isPlaceholder ?? false,
    publishedAt: null,
    fetchedAt: now,
    contentHash: params.contentHash,
    spamScore: null,
    isSpam: false,
    listUnsubscribeMailto: null,
    listUnsubscribeHttps: null,
    listUnsubscribePost: null,
    createdAt: now,
    updatedAt: now,
  };
  const inserted = await db.transaction(async (tx) => {
    const insertedRows = await tx
      .insert(entries)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: entries.id });

    // Conflict: another save already created this (owner_user_id, guid). Abort so the
    // caller can return the existing article idempotently.
    if (insertedRows.length === 0) {
      return false;
    }

    // The article belongs to the user's saved subscription (#1846), its origin,
    // which their first save creates. (The one exception to the lock order:
    // only another first save for this user contends for it.)
    await tx.execute(sql`SELECT ensure_saved_subscriptions(ARRAY[${userId}::uuid])`);
    const [membership] = await insertUserEntriesWithMemberships(
      tx,
      sql`
        SELECT s.id AS subscription_id, s.user_id, e.id AS entry_id,
               COALESCE(e.published_at, e.fetched_at) AS published_or_fetched_at,
               e.is_spam, false AS read
        FROM subscriptions s
        JOIN entries e ON e.id = ${entryId}
        WHERE s.user_id = ${userId} AND s.type = 'saved'
      `
    );
    return { savedSubscriptionId: membership.subscriptionId };
  });

  if (!inserted) {
    return null;
  }

  const listItem: NewEntryListItem = {
    entryId,
    subscriptionId: inserted.savedSubscriptionId,
    // A new entry's one membership is its origin (#1846).
    subscriptionIds: [inserted.savedSubscriptionId],
    updatedAt: now.toISOString(),
    entry: toNewEntryListData(values, SAVED_ARTICLES_TITLE),
  };
  // Fire-and-forget: SSE is best-effort and must never fail the save response
  // (the entry transaction has already committed). See entry-events.ts.
  publishUserEvent({
    type: "new_entry",
    userId,
    subscriptionId: inserted.savedSubscriptionId,
    feedType: "saved",
    entryId,
    updatedAt: now,
    entry: listItem.entry,
  });

  // Sanitize the body for the returned SavedArticle: callers like the Wallabag
  // POST response send it to clients, so raw fetched HTML must not leave the
  // service layer here either.
  const contentCleaned = await sanitizeEntryHtmlAsync(params.contentCleaned);

  return {
    article: {
      id: entryId,
      url: params.url,
      title: params.title,
      siteName: params.siteName,
      author: params.author,
      imageUrl: params.imageUrl,
      contentCleaned,
      excerpt: params.summary,
      read: false,
      starred: false,
      savedAt: now,
    },
    listItem,
  };
}

/** Display site name for an uploaded file, by type. */
const UPLOAD_SITE_NAMES: Record<SupportedFileType, string> = {
  docx: "Uploaded Document",
  pdf: "Uploaded PDF",
  html: "Uploaded HTML",
  markdown: "Uploaded Text",
};

/** The derived fields an uploaded (null-URL) article is stored with. */
type UploadedArticleFields = Omit<BuiltArticleFields, "newTextContent">;

/**
 * Insert a null-URL (uploaded) saved article from already-derived fields.
 *
 * Uploaded articles have no URL, so — unlike {@link saveArticle} — there is no
 * existing-by-URL lookup, refetch, quality guard, or placeholder heal. The guid
 * is the caller's {@link uploadGuid} for an idempotent upload, whose duplicate
 * returns the article already saved, or else a fresh random one. This is the
 * shared tail for every upload path (file upload, Markdown, pre-cleaned HTML).
 */
export async function insertUploadedArticle(
  db: typeof dbType,
  userId: string,
  fields: UploadedArticleFields,
  guid: string = `uploaded:${generateUuidv7()}`,
  id?: string
): Promise<InsertedSavedArticle> {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
  if (Buffer.byteLength(fields.contentOriginal, "utf8") > maxSize) {
    throw errors.contentTooLarge("Uploaded article", maxSize);
  }

  const saved = await insertSavedEntry(db, userId, {
    ...fields,
    id,
    guid,
    url: null,
  });

  if (!saved) {
    // The same idempotent upload, saved concurrently.
    const existing = await selectExistingUpload(db, userId, guid);
    if (!existing) throw new Error("Uploaded article insert conflicted with no article");
    return existing;
  }

  logger.info("Created uploaded article", {
    entryId: saved.article.id,
    title: fields.title,
    siteName: fields.siteName,
  });

  return saved;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Normalizes a URL exactly the way {@link saveArticle} does before storing it as
 * the entry `guid`: strip fragments (two URLs differing only by `#section` point
 * to the same article), then apply its plugin's `normalizeUrl`. Existence
 * checks must use this so they match saved rows.
 */
function normalizeSavedUrl(url: string): string {
  return normalizeSavedArticleUrl(normalizeUrl(url));
}

/**
 * Checks whether the user has already saved an article for the given URL,
 * returning its entry id (or null). Read-only, so it's safe on probe/exists
 * paths.
 */
export async function savedArticleExistsByUrl(
  db: typeof dbType,
  userId: string,
  url: string
): Promise<string | null> {
  const [existing] = await db
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.ownerUserId, userId),
        eq(entries.guid, normalizeSavedUrl(url)),
        eq(userEntries.userId, userId)
      )
    )
    .limit(1);
  return existing?.id ?? null;
}

/**
 * The saved (entry, user state) row for this (user, normalized URL), if any:
 * a seek on the `(owner_user_id, guid)` unique index (#1846).
 */
async function selectExistingSavedRow(db: typeof dbType, userId: string, normalizedUrl: string) {
  const [row] = await db
    .select({ entry: entries, userState: userEntries })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.ownerUserId, userId),
        eq(entries.guid, normalizedUrl),
        eq(userEntries.userId, userId)
      )
    )
    .limit(1);
  return row;
}

/**
 * Shape an already-saved row into a {@link SavedArticle}, sanitizing the stored
 * raw body per read off the event loop (raw content must not leave the service
 * layer).
 */
async function savedArticleFromRow({
  entry,
  userState,
}: NonNullable<Awaited<ReturnType<typeof selectExistingSavedRow>>>): Promise<SavedArticle> {
  const { cleaned } = await sanitizeEntryContentFamily("content", {
    original: entry.contentOriginal,
    cleaned: entry.contentCleaned,
  });
  return {
    id: entry.id,
    url: entry.url,
    title: entry.title,
    siteName: entry.siteName,
    author: entry.author,
    imageUrl: entry.imageUrl,
    contentCleaned: cleaned,
    excerpt: entry.summary,
    read: userState.read,
    starred: userState.starred,
    savedAt: entry.fetchedAt,
  };
}

/** An already-saved row as a {@link SaveArticleResult} with outcome `"existing"`. */
async function toExistingSavedArticle(
  row: NonNullable<Awaited<ReturnType<typeof selectExistingSavedRow>>>
): Promise<SaveArticleResult> {
  return { ...(await savedArticleFromRow(row)), outcome: "existing" };
}

const UPLOAD_ROW = { userId: userEntries.userId, entryId: userEntries.entryId };
const UPLOAD_MEMBERSHIPS = entryMemberships(UPLOAD_ROW);

/**
 * The upload saved earlier under `guid`, shaped like a fresh upload's result,
 * list item included (with the collections it has been filed into since).
 */
export async function selectExistingUpload(
  db: typeof dbType,
  userId: string,
  guid: string
): Promise<InsertedSavedArticle | null> {
  const [row] = await db
    .select({
      entry: entries,
      userState: userEntries,
      subscriptionId: subscriptions.id,
      subscriptionIds: UPLOAD_MEMBERSHIPS.subscriptionIds,
    })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .leftJoinLateral(UPLOAD_MEMBERSHIPS, sql`true`)
    .leftJoin(subscriptions, entryOriginOn(UPLOAD_MEMBERSHIPS, UPLOAD_ROW))
    .where(
      and(eq(entries.ownerUserId, userId), eq(entries.guid, guid), eq(userEntries.userId, userId))
    )
    .limit(1);
  if (!row?.subscriptionId) return null;
  const { entry, userState } = row;
  return {
    article: await savedArticleFromRow(row),
    listItem: {
      entryId: entry.id,
      subscriptionId: row.subscriptionId,
      subscriptionIds: row.subscriptionIds,
      updatedAt: userState.updatedAt.toISOString(),
      entry: toNewEntryListData(entry, SAVED_ARTICLES_TITLE, {
        read: userState.read,
        starred: userState.starred,
      }),
    },
  };
}

/**
 * Re-select an already-saved article **without** triggering a refetch, for
 * {@link saveArticle}'s post-conflict idempotent return and
 * {@link savePlaceholderArticle}'s conflict fallback (which must not refetch,
 * since a placeholder always refetches on the normal saveArticle path).
 * Returns null if no such row exists.
 */
async function selectExistingSavedArticle(
  db: typeof dbType,
  userId: string,
  normalizedUrl: string
): Promise<SaveArticleResult | null> {
  const row = await selectExistingSavedRow(db, userId, normalizedUrl);
  return row ? toExistingSavedArticle(row) : null;
}

/**
 * Save a URL for later reading.
 *
 * Fetches the URL (or uses caller-provided HTML), extracts metadata and clean
 * content via Readability, and stores it as a saved article. If the URL is
 * already saved, returns the existing article — or, with `refetch`, updates
 * it in place (guarded by a content-quality comparison unless `force`).
 *
 * Uses the plugin system for special URL handling (LessWrong, ArXiv, Google
 * Docs, etc.); sources needing the user's own credentials (private Google
 * Docs) are fetched via the `userAuth` option.
 */
export async function saveArticle(
  db: typeof dbType,
  userId: string,
  params: SaveArticleParams
): Promise<SaveArticleResult> {
  return withCollections(db, userId, params.collectionIds, () =>
    saveArticleContent(db, userId, params)
  );
}

/**
 * Runs a save, then files the article into `collectionIds`. A bad id fails
 * before anything is saved (or fetched). The add itself is best effort and
 * re-checks ownership under lock, adding only an article the user can see
 * (`addEntryToCollections`), so a collection never grants access.
 */
async function withCollections<T extends SavedArticle | InsertedSavedArticle>(
  db: typeof dbType,
  userId: string,
  collectionIds: string[] = [],
  save: () => Promise<T>
): Promise<T> {
  await assertOwnedCollections(db, userId, collectionIds);
  const saved = await save();
  const articleId = "article" in saved ? saved.article.id : saved.id;
  await addEntryToCollections(db, userId, articleId, collectionIds);
  return saved;
}

async function saveArticleContent(
  db: typeof dbType,
  userId: string,
  params: SaveArticleParams
): Promise<SaveArticleResult> {
  const normalizedUrl = normalizeSavedUrl(params.url);

  // Check if URL is already saved (guid = normalized URL for saved articles).
  // A placeholder (a failed-save stand-in, see savePlaceholderArticle) always
  // refetches on re-save so a transiently-failed URL self-heals into the real
  // article — even for the no-refetch callers (a plain Wallabag re-share, a
  // plain MCP save_article). A real saved article still returns instantly unless the
  // caller opted into refetch. See #1256.
  const existingEntry = await selectExistingSavedRow(db, userId, normalizedUrl);
  if (existingEntry && !params.refetch && !existingEntry.entry.isPlaceholder) {
    return toExistingSavedArticle(existingEntry);
  }

  const bundle = await acquireSavedArticleContent(userId, params);

  // Derive the stored fields from the acquired content. Shared with the upload
  // paths (buildArticleFields) so save and upload stay in lockstep.
  const {
    title: finalTitle,
    author: finalAuthor,
    siteName: finalSiteName,
    contentOriginal,
    contentCleaned: finalContentCleaned,
    summary: excerpt,
    imageUrl,
    contentHash,
    newTextContent,
  } = await buildArticleFields(bundle, {
    providedTitle: params.title ?? null,
    providedAuthor: params.author ?? null,
    providedExcerpt: params.excerpt ?? null,
  });

  // Handle refetch: update the existing entry if quality is acceptable
  if (existingEntry) {
    const { entry: oldEntry, userState } = existingEntry;
    const now = new Date();

    // A placeholder body is intentionally tiny (URL + failure reason), so the
    // "reject if new content is worse" guard would reject nearly every real
    // article that replaces it. Replacing a placeholder with any real content
    // should always win — treat it as force-equivalent (#1256).
    const skipQualityGuard = params.force || oldEntry.isPlaceholder;

    // Compare content quality to avoid overwriting good content with bad
    // (e.g., private Google Doc fetched with auth, refetched without)
    if (!skipQualityGuard) {
      const oldTextLength = oldEntry.contentCleaned ? stripHtml(oldEntry.contentCleaned).length : 0;

      const newTextLength = newTextContent.length;

      // Reject if new content is significantly shorter AND short in absolute terms
      // This catches error pages and access-denied pages while allowing legitimate edits
      const isSignificantlyWorse = newTextLength < oldTextLength * 0.5 && newTextLength < 500;

      if (isSignificantlyWorse) {
        logger.warn("Refetch rejected: new content appears worse", {
          url: normalizedUrl,
          oldTextLength,
          newTextLength,
          ratio: oldTextLength > 0 ? newTextLength / oldTextLength : 0,
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "The refetched content appears significantly shorter than the original. This often happens when a private document is refetched without authentication. Use force=true to override.",
          cause: {
            code: "REFETCH_CONTENT_WORSE",
            details: {
              url: normalizedUrl,
              oldLength: oldTextLength,
              newLength: newTextLength,
            },
          },
        });
      }
    }

    // Update the existing entry with the new raw content; sanitization is per
    // read now (issue #1282).
    const update = {
      title: finalTitle,
      author: finalAuthor,
      contentOriginal,
      contentCleaned: finalContentCleaned,
      summary: excerpt,
      siteName: finalSiteName,
      imageUrl,
      contentHash,
      updatedAt: now,
      // A successful real save clears the placeholder mark (no-op when the
      // entry was already a real article). See #1256.
      isPlaceholder: false,
    };
    // Update the content and flip the entry back to unread atomically. The
    // unread flip is routed through writeEntriesRead (rather than a bare
    // `read=false` UPDATE) so it maintains read_changed_at (the changedAt
    // idempotency contract — otherwise a stale queued offline "mark read" older
    // than this refetch would win later) and bumps updated_at (so sync.events
    // reports it to offline clients). Both writes share one transaction so a
    // crash can't leave new content with the old read state.
    const { changed: readChanged } = await db.transaction(async (tx) => {
      await tx.update(entries).set(update).where(eq(entries.id, oldEntry.id));
      return writeEntriesRead(tx, userId, [{ id: oldEntry.id, changedAt: now }], false);
    });
    // Notifies other tabs of the unread flip, if it was one.
    await finishEntriesRead(db, userId, readChanged);

    logger.info("Refetched saved article", {
      entryId: oldEntry.id,
      url: normalizedUrl,
      forced: params.force ?? false,
    });

    // Publish event to notify other browser windows/tabs of the content update.
    // Fire-and-forget: SSE is best-effort and must never fail the response (the
    // transaction has already committed). See entry-events.ts.
    publishUserEvent({
      type: "entry_updated",
      userId,
      subscriptionId: null,
      entryId: oldEntry.id,
      updatedAt: now,
      metadata: toEntryMetadata({
        title: finalTitle,
        author: finalAuthor,
        summary: excerpt,
        url: normalizedUrl,
        publishedAt: oldEntry.publishedAt,
      }),
    });

    return {
      id: oldEntry.id,
      url: normalizedUrl,
      title: finalTitle,
      siteName: finalSiteName,
      author: finalAuthor,
      imageUrl,
      // Sanitize the body for the response (raw must not leave the service layer).
      contentCleaned: await sanitizeEntryHtmlAsync(finalContentCleaned),
      excerpt,
      read: false, // Marked unread since content was updated
      starred: userState.starred,
      savedAt: oldEntry.fetchedAt, // Keep original save time
      outcome: "updated",
    };
  }

  const saved = await insertSavedEntry(db, userId, {
    guid: normalizedUrl,
    url: normalizedUrl,
    title: finalTitle,
    author: finalAuthor,
    contentOriginal,
    contentCleaned: finalContentCleaned,
    summary: excerpt,
    siteName: finalSiteName,
    imageUrl,
    contentHash,
  });

  // A concurrent save (e.g. a double-click) already inserted this (owner_user_id,
  // guid) between our existence check above and the insert. Return the existing
  // article idempotently instead of surfacing a unique-violation 500 (#952).
  if (!saved) {
    const existingResult = await selectExistingSavedArticle(db, userId, normalizedUrl);
    if (!existingResult) {
      // Should not happen: the insert only aborts on an existing row.
      throw new Error(`Saved article vanished after conflict: ${normalizedUrl}`);
    }
    return existingResult;
  }

  logger.info("Saved article", {
    entryId: saved.article.id,
    url: normalizedUrl,
    title: finalTitle,
  });

  return { ...saved.article, outcome: "created" };
}

/**
 * Save a placeholder entry recording that a URL could **not** be fetched/saved.
 *
 * This exists only for the Wallabag POST surface. The Wallabag Android app's
 * offline save queue advances an item only on a 2xx response; any error keeps
 * the item queued and retried forever AND halts every newer queued save behind
 * it (a poison item — see #1254). So when a save fails for a *permanent*
 * client-side reason (oversized page, 404, blocked site, feed URL, …) the
 * Wallabag route can't just return the 4xx — it saves this labeled placeholder
 * and returns 200, which drains the queue and tells the user in-app why the save
 * failed. Genuine 5xx server bugs are deliberately NOT turned into placeholders
 * (the caller still throws), so the app legitimately retries them once the bug
 * is fixed.
 *
 * The entry keeps the original URL (so it stays clickable and the save is
 * idempotent by URL), uses the URL as its title, and the failure reason as its
 * body. It is flagged `is_placeholder = true` (see below). Interactive callers
 * (tRPC/MCP) must keep surfacing the real error instead of calling this.
 *
 * Self-heal (#1256): the placeholder is stored under `guid = normalized URL`, so
 * a later save of the same URL matches it. Because it's flagged, {@link
 * saveArticle} always **refetches** a placeholder on re-save (even for the
 * no-refetch callers — a plain Wallabag re-share or MCP `save_article`) and, on
 * success, replaces it with the real article. So a transiently-failed URL
 * (`UPSTREAM_RATE_LIMITED`, `SITE_BLOCKED`) heals on the next re-share instead of
 * being stuck behind the placeholder. Only *this* function's own conflict
 * fallback (below) returns the existing placeholder without refetching, so a
 * re-fetch that fails *again* still drains the Wallabag queue with a 200 rather
 * than looping.
 */
export async function savePlaceholderArticle(
  db: typeof dbType,
  userId: string,
  params: { url: string; reason: string }
): Promise<SaveArticleResult> {
  const normalizedUrl = normalizeSavedUrl(params.url);

  // The placeholder body is our own short, trusted text; escape the reason (it
  // embeds the failing URL / upstream message) so it can't inject markup. It's
  // sanitized again at write time by insertSavedEntry regardless.
  const body = `<p>Lion Reader couldn't save this page.</p><p>${escapeHtml(params.reason)}</p>`;
  const contentHash = generateContentHash(params.url, body);

  const saved = await insertSavedEntry(db, userId, {
    guid: normalizedUrl,
    url: normalizedUrl,
    title: params.url,
    author: null,
    contentOriginal: body,
    contentCleaned: body,
    summary: params.reason,
    siteName: null,
    imageUrl: null,
    contentHash,
    isPlaceholder: true,
  });

  if (saved) {
    logger.info("Saved placeholder for failed article save", {
      entryId: saved.article.id,
      url: normalizedUrl,
    });
    return { ...saved.article, outcome: "created" };
  }

  // The (owner_user_id, guid) already exists: this URL was previously saved (a real
  // article or an earlier placeholder), or two queued retries raced. Return the
  // existing entry idempotently instead of a unique-violation.
  //
  // Deliberately re-select directly rather than calling saveArticle: a
  // placeholder now always *refetches* on the saveArticle path, and a refetch
  // that fails again would throw here — breaking this surface's contract of
  // draining the Wallabag queue with a 200. (This is reached only after our own
  // insert lost a race with an existing row, so a fresh fetch here would be
  // wasted work anyway.)
  const existingResult = await selectExistingSavedArticle(db, userId, normalizedUrl);
  if (!existingResult) {
    // Should not happen: the insert only aborts on an existing row.
    throw new Error(`Saved placeholder vanished after conflict: ${normalizedUrl}`);
  }
  return existingResult;
}

/**
 * Delete a saved article.
 *
 * @returns the counts of the lists it left (the global ones and its
 *   collections), or null if not found
 */
export async function deleteSavedArticle(
  db: typeof dbType,
  userId: string,
  articleId: string
): Promise<BulkUnreadCounts | null> {
  // Verify the article exists and is one the user saved (owns, #1846).
  const existing = await db
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.id, articleId),
        eq(entries.ownerUserId, userId),
        eq(userEntries.userId, userId)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return null;
  }

  // Delete the entry (will cascade to user_entries). Scope the DELETE to the
  // user's own articles as well as the id — the ownership SELECT above already
  // guarantees it, but pinning the owner keeps the mutation self-evidently
  // user-scoped in isolation (defense-in-depth against a future refactor).
  //
  // The tombstone lets delta-sync clients drop their copy; it commits with the
  // delete so a client can never see one without the other.
  const collectionIds = await listEntryCollectionIds(db, userId, articleId);
  await db.transaction(async (tx) => {
    await tx.delete(entries).where(and(eq(entries.id, articleId), eq(entries.ownerUserId, userId)));
    await recordEntryTombstone(tx, userId, articleId);
    await enqueueStoredObjectsDeletion(tx, entryObjectsPrefix(userId, articleId));
  });
  // The entry is gone, so its collections are named as subscriptions.
  const counts = await getBulkEntryRelatedCounts(
    db,
    userId,
    collectionIds.map((subscriptionId) => ({ subscriptionId }))
  );
  publishEntryLeftCollections(userId, articleId, collectionIds, counts);
  return counts;
}

export interface UploadFileParams extends CollectionsParam {
  /** The file's bytes, base64-encoded. */
  content: string;
  /** The original filename: picks the converter, and is the last-resort title. */
  filename: string;
  title?: string;
  /**
   * Makes the upload idempotent: a repeat with the same key (a retry after a
   * lost response) returns the article the first one saved, unconverted.
   */
  idempotencyKey?: string;
}

/** An idempotent upload's guid; unique per user, like every saved guid. */
function uploadGuid(idempotencyKey: string): string {
  return `uploaded:key:${idempotencyKey}`;
}

/**
 * Enforces the saved article size limit on an upload's raw bytes, before any
 * conversion (mammoth, Readability, Markdown) can burn memory or CPU on it.
 */
export function assertUploadSize(resource: string, bytes: number): void {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
  if (bytes > maxSize) {
    throw errors.contentTooLarge(resource, maxSize);
  }
}

/**
 * Save an uploaded file (.docx, .pdf, .html, .md, .txt; see `convertUploadedFile`).
 *
 * The converted content runs through the same {@link buildArticleFields} pipeline
 * as a URL save — Readability, excerpt, and title/author/site-name precedence —
 * with a null URL and the filename as a last-resort title.
 */
export async function uploadFile(
  db: typeof dbType,
  userId: string,
  params: UploadFileParams
): Promise<InsertedSavedArticle> {
  const { filename } = params;
  const fileType = detectFileType(filename);
  if (!fileType) {
    throw errors.validation(`Unsupported file type. ${getSupportedTypesDescription()}`);
  }
  // Node's decoder never throws — it skips non-base64 characters — so content
  // that isn't really base64 decodes to garbage bytes, which conversion rejects.
  const file = Buffer.from(params.content, "base64");
  assertUploadSize("Uploaded file", file.length);

  return withCollections(db, userId, params.collectionIds, async () => {
    const guid = params.idempotencyKey ? uploadGuid(params.idempotencyKey) : undefined;
    const existing = guid ? await selectExistingUpload(db, userId, guid) : null;
    if (existing) return existing;

    const converted = await convertUpload(file, filename);
    const fields = await buildArticleFields(
      {
        html: converted.html,
        contentUrl: null,
        pluginContent: null,
        preCleanedContent: converted.preCleanedContent,
      },
      {
        providedTitle: params.title ?? null,
        filename,
        siteName: UPLOAD_SITE_NAMES[fileType],
      },
      { minCleanedLength: 10 }
    );
    return insertUploadedArticle(db, userId, fields, guid);
  });
}

/**
 * Upload an article with Markdown content.
 *
 * Creates a saved article from Markdown content without requiring a URL.
 * Useful for AI assistants uploading content directly. Shares the same
 * downstream processing as file uploads and URL saves via
 * {@link buildArticleFields}.
 */
export async function uploadArticle(
  db: typeof dbType,
  userId: string,
  params: UploadArticleParams
): Promise<SavedArticle> {
  assertUploadSize("Uploaded article", Buffer.byteLength(params.content, "utf8"));

  return withCollections(db, userId, params.collectionIds, async () => {
    const guid = params.idempotencyKey ? uploadGuid(params.idempotencyKey) : undefined;
    const existing = guid ? await selectExistingUpload(db, userId, guid) : null;
    if (existing) return existing.article;

    // Convert markdown to HTML (with frontmatter title/summary/author); Readability
    // is skipped downstream because preCleanedContent is set.
    const markdownResult = await processMarkdown(params.content);
    const fields = await buildArticleFields(
      {
        html: markdownResult.html,
        contentUrl: null,
        pluginContent: null,
        preCleanedContent: markdownResult,
      },
      {
        providedTitle: params.title,
        providedAuthor: params.author ?? null,
        providedExcerpt: params.excerpt ?? null,
        siteName: "Uploaded Article",
      },
      { keepRelativeUrls: params.keepRelativeUrls }
    );
    return (await insertUploadedArticle(db, userId, fields, guid)).article;
  });
}
