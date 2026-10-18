/**
 * Saved Articles Service
 *
 * Business logic for saving articles. Used by both tRPC routers and MCP server.
 * Uses the plugin system for special URL handling (LessWrong, ArXiv, Google Docs, etc.).
 */

import { eq, and, sql } from "drizzle-orm";
import { Parser } from "htmlparser2";
import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import type { db as dbType } from "@/server/db";
import { entries, userEntries } from "@/server/db/schema";
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
import { normalizeUrl } from "@/lib/url";
import {
  fetchUrl as fetchRawUrl,
  HttpFetchError,
  ContentTooLargeError,
  InvalidContentTypeError,
} from "@/server/http/fetch";
import { parseFeed } from "@/server/feed/parser";
import { processMarkdown } from "@/server/markdown";
import {
  articleContentFromAcquired,
  processArticleContent,
  type ArticleContentBundle,
} from "./article-content";
import {
  convertUploadedFile,
  detectFileType,
  getSupportedTypesDescription,
  titleFromFilename,
  type ConvertedUpload,
} from "@/server/file/process-upload";
import { type SupportedFileType } from "@/lib/upload-file-types";
import { usageLimitsConfig } from "@/server/config/env";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
import { stripHtml } from "@/server/html/strip-html";
import { computeSavedArticleExcerpt } from "@/server/services/saved-excerpt";
import { escapeHtml } from "@/server/http/html";
import { sanitizeEntryContentFamily } from "@/server/html/sanitize-entry";
import { logger } from "@/lib/logger";
import { publishUserEvent } from "@/server/redis/pubsub";
import { entryListPayload, toEntryMetadata } from "@/server/services/entry-sync-events";
import { errors } from "@/server/errors";
import { finishEntriesRead, writeEntriesRead } from "@/server/services/entries";
import {
  acquireArticleContent,
  normalizeSavedArticleUrl,
  UserFetchError,
  type AcquiredArticle,
  type UserAuthMode,
} from "@/server/plugins";

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
}

export interface SavedArticle {
  id: string;
  /** URL of the article (null for uploaded content) */
  url: string | null;
  title: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
  /**
   * Sanitized article body. The Wallabag POST response sends it to clients as
   * `content` (via `formatSavedArticle`), so raw fetched HTML must never appear
   * here.
   */
  contentCleaned: string | null;
  excerpt: string | null;
  read: boolean;
  starred: boolean;
  savedAt: Date;
}

// ============================================================================
// Helper Functions
// ============================================================================

interface PageMetadata {
  title: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
}

/**
 * Extracts metadata from HTML using Open Graph and meta tags.
 * Uses SAX parsing for efficiency and exits early after </head>.
 */
function extractMetadata(html: string, url: string): PageMetadata {
  const result: PageMetadata = {
    title: null,
    siteName: null,
    author: null,
    imageUrl: null,
  };

  let ogTitle: string | null = null;
  let titleText: string | null = null;
  let inTitle = false;
  let titleContent = "";

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const tagName = name.toLowerCase();

        if (tagName === "title") {
          inTitle = true;
          titleContent = "";
        } else if (tagName === "meta") {
          const property = attribs.property?.toLowerCase();
          const metaName = attribs.name?.toLowerCase();
          const content = attribs.content;

          if (property === "og:title" && content && !ogTitle) {
            ogTitle = content;
          } else if (property === "og:site_name" && content && !result.siteName) {
            result.siteName = content;
          } else if (property === "og:image" && content && !result.imageUrl) {
            result.imageUrl = content;
          } else if (property === "article:author" && content && !result.author) {
            result.author = content;
          } else if (metaName === "author" && content && !result.author) {
            result.author = content;
          }
        }
      },
      ontext(text) {
        if (inTitle) {
          titleContent += text;
        }
      },
      onclosetag(name) {
        const tagName = name.toLowerCase();

        if (tagName === "title") {
          inTitle = false;
          if (titleContent.trim() && !titleText) {
            titleText = titleContent.trim();
          }
        } else if (tagName === "head") {
          parser.pause();
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  result.title = ogTitle || titleText;

  if (result.imageUrl && !result.imageUrl.startsWith("http")) {
    try {
      result.imageUrl = new URL(result.imageUrl, url).href;
    } catch {
      result.imageUrl = null;
    }
  }

  return result;
}

/**
 * Generates a SHA-256 content hash for saved article.
 * Used for narration deduplication.
 */
function generateContentHash(title: string | null, content: string | null): string {
  const titleStr = title ?? "";
  const contentStr = content ?? "";
  const hashInput = `${titleStr}\n${contentStr}`;
  return createHash("sha256").update(hashInput, "utf8").digest("hex");
}

/**
 * Reserved-TLD base URL for uploaded content, which has no real origin. Relative
 * URLs in uploads resolve against this instead of Lion Reader's own domain, so a
 * stray relative link becomes an obviously-broken external URL rather than one
 * that silently points back into the app. `.invalid` never resolves (RFC 6761).
 */
const UPLOAD_BASE_URL = "https://uploaded.invalid/";

/** Caller-supplied hints that outrank (title) or backstop (filename) extraction. */
interface ArticleFieldHints {
  /** Explicit caller-provided title — highest precedence. */
  providedTitle?: string | null;
  /** Explicit caller-provided author — highest precedence. */
  providedAuthor?: string | null;
  /** Explicit caller-provided excerpt/summary — highest precedence. */
  providedExcerpt?: string | null;
  /** Upload filename, used only as a last-resort title (below Readability). */
  filename?: string | null;
  /** Provided site name (uploads: "Uploaded Document", etc.). */
  siteName?: string | null;
}

/** The stored article fields buildArticleFields derives, plus quality-guard text. */
interface BuiltArticleFields {
  title: string | null;
  author: string | null;
  siteName: string | null;
  contentOriginal: string;
  contentCleaned: string | null;
  summary: string | null;
  imageUrl: string | null;
  contentHash: string;
  /** Plain text of the new content, for the refetch quality guard. */
  newTextContent: string;
}

/**
 * Turn an acquired content bundle into the stored article fields — shared by the
 * URL-save path and the file/Markdown upload paths, so both derive title, author,
 * site name, excerpt, cleaned content, and image identically. The only thing that
 * differs between "save" and "upload" is how the bundle was acquired (fetch vs.
 * file conversion) and that uploads carry a null URL.
 *
 * Field precedence:
 *  - title:  provided → plugin / Markdown frontmatter / docx core.xml → Readability → OG or `<title>` → filename
 *  - author: provided → plugin / frontmatter / docx core.xml → Readability byline → OG/meta author
 *  - excerpt: see {@link computeSavedArticleExcerpt} (provided → plugin excerpt → source metadata → cleaned → plugin/pre-cleaned HTML)
 */
async function buildArticleFields(
  bundle: ArticleContentBundle,
  hints: ArticleFieldHints = {},
  // Uploads are trusted user content, so they pass a lower minCleanedLength than
  // a web fetch (where a short extraction usually means a failed JS-heavy page).
  {
    keepRelativeUrls = false,
    ...cleanOptions
  }: { minCleanedLength?: number; keepRelativeUrls?: boolean } = {}
): Promise<BuiltArticleFields> {
  const { html, contentUrl, pluginContent, preCleanedContent } = bundle;
  // Uploads have no origin; a guaranteed-broken base keeps relative URLs from
  // resolving against Lion Reader itself.
  const baseUrl = contentUrl ?? UPLOAD_BASE_URL;

  const metadata = extractMetadata(html, baseUrl);
  const {
    contentOriginal,
    contentCleaned,
    readability: cleaned,
  } = await processArticleContent(bundle, keepRelativeUrls ? null : baseUrl, {
    offload: true,
    ...cleanOptions,
  });

  // Precedence: explicit caller value → plugin / Markdown frontmatter / docx
  // core.xml → Readability → raw Open Graph/<title>/meta scrape → filename (title only).
  //
  // Readability sits above the raw `metadata` scrape (both for title and author)
  // because Readability is itself a "source-specific" extractor that mostly reads
  // the same Open Graph/meta tags — but when it and the raw scrape disagree, we
  // trust Readability to have done better (e.g. stripping a " | Site Name" title
  // suffix, or picking the real byline over a generic `meta[name=author]`). It
  // only returns a value when it also extracted the body, so the raw `metadata`
  // scrape stays just below it as the fallback that survives a failed extraction
  // (short/unparseable page). This ordering is HTML-only in practice: Readability
  // is skipped for Markdown (frontmatter wins) and for plugins that opt out
  // (`cleaned` is null), so those correctly prefer their own declared metadata.
  // dom_smoothie cleans up the title in some cases (e.g. stripping a
  // " | Site Name" suffix) that our simpler raw scrape doesn't, so we prefer its
  // output when it exists
  const title =
    hints.providedTitle ||
    pluginContent?.title ||
    preCleanedContent?.title ||
    cleaned?.title ||
    metadata.title ||
    (hints.filename ? titleFromFilename(hints.filename) || null : null) ||
    null;
  const author =
    hints.providedAuthor ||
    pluginContent?.author ||
    preCleanedContent?.author ||
    cleaned?.byline ||
    metadata.author ||
    null;
  const siteName = hints.siteName || pluginContent?.siteName || metadata.siteName || null;

  const summary = computeSavedArticleExcerpt({
    providedExcerpt: hints.providedExcerpt,
    preCleanedContent,
    cleaned,
    pluginContent,
    html,
  });

  const contentHash = generateContentHash(title, contentCleaned || html);

  // Plain text for the refetch quality guard: prefer the raw plugin body, else
  // Readability's text, else the raw HTML stripped.
  const newTextContent = pluginContent
    ? stripHtml(pluginContent.html)
    : cleaned
      ? cleaned.textContent
      : stripHtml(html);

  return {
    title,
    author,
    siteName,
    contentOriginal,
    contentCleaned,
    summary,
    imageUrl: metadata.imageUrl,
    contentHash,
    newTextContent,
  };
}

// ============================================================================
// Shared Insert Helper
// ============================================================================

interface InsertSavedEntryParams {
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
 * in that case. Uploads use a random `uploaded:{uuid}` guid, so they never
 * conflict and always get a row back.
 */
async function insertSavedEntry(
  db: typeof dbType,
  userId: string,
  params: InsertSavedEntryParams
): Promise<SavedArticle | null> {
  const now = new Date();
  const entryId = generateUuidv7();

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

  // Fire-and-forget: SSE is best-effort and must never fail the save response
  // (the entry transaction has already committed). See entry-events.ts.
  publishUserEvent({
    type: "new_entry",
    userId,
    subscriptionId: inserted.savedSubscriptionId,
    feedType: "saved",
    entryId,
    updatedAt: now,
    entry: entryListPayload(values, SAVED_ARTICLES_TITLE),
  });

  // Sanitize the body for the returned SavedArticle: callers like the Wallabag
  // POST response send it to clients, so raw fetched HTML must not leave the
  // service layer here either.
  const contentCleaned = await sanitizeEntryHtmlAsync(params.contentCleaned);

  return {
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
  };
}

/** Display site name for an uploaded file, by type. */
const UPLOAD_SITE_NAMES: Record<SupportedFileType, string> = {
  docx: "Uploaded Document",
  html: "Uploaded HTML",
  markdown: "Uploaded Text",
};

/** The derived fields an uploaded (null-URL) article is stored with. */
type UploadedArticleFields = Omit<BuiltArticleFields, "newTextContent">;

/**
 * Insert a null-URL (uploaded) saved article from already-derived fields.
 *
 * Uploaded articles have no URL, so — unlike {@link saveArticle} — there is no
 * existing-by-URL lookup, refetch, quality guard, or placeholder heal: the guid
 * is a fresh random `uploaded:{uuid}` that never conflicts. This is the shared
 * tail for every upload path (file upload, Markdown, pre-cleaned HTML).
 */
async function insertUploadedArticle(
  db: typeof dbType,
  userId: string,
  fields: UploadedArticleFields
): Promise<SavedArticle> {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
  if (Buffer.byteLength(fields.contentOriginal, "utf8") > maxSize) {
    throw errors.contentTooLarge("Uploaded article", maxSize);
  }

  // Fresh random guid → the insert can't conflict.
  const guid = `uploaded:${generateUuidv7()}`;

  const saved = await insertSavedEntry(db, userId, {
    ...fields,
    guid,
    url: null,
  });

  if (!saved) {
    throw new Error("Uploaded article insert unexpectedly conflicted");
  }

  logger.info("Created uploaded article", {
    entryId: saved.id,
    title: fields.title,
    siteName: fields.siteName,
  });

  return saved;
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Content types that are unambiguously a feed. When a page fetch is rejected
 * with one of these, we can route to Subscribe without a second fetch.
 */
const UNAMBIGUOUS_FEED_CONTENT_TYPES = [
  "application/rss+xml",
  "application/atom+xml",
  "application/feed+json",
];

/**
 * Decide whether a URL that failed a page fetch on its content type is actually
 * a feed (so the caller can route the user to Subscribe instead of failing the
 * save). Unambiguous feed content types short-circuit; ambiguous XML/JSON
 * (`text/xml`, `application/xml`, `application/json`) is confirmed by fetching
 * and actually parsing it as a feed — so a sitemap (`<urlset>`) or a plain JSON
 * API (no JSON Feed `version`/`items`) is correctly rejected rather than
 * misrouted to Subscribe. Only reached on the rare feed-rejection path, so the
 * common article save stays a single fetch.
 */
async function urlIsDirectFeed(url: string, contentType: string): Promise<boolean> {
  const normalized = contentType.toLowerCase();
  if (UNAMBIGUOUS_FEED_CONTENT_TYPES.some((type) => normalized.includes(type))) {
    return true;
  }
  try {
    const { text } = await fetchRawUrl(url);
    // parseFeed throws for unknown formats and for structurally-invalid feeds
    // (a sitemap, a plain JSON object, etc.) — exactly what we want to exclude.
    parseFeed(text);
    return true;
  } catch {
    // Not fetchable or not a real feed: treat as not-a-feed and let the original
    // fetch error surface.
    return false;
  }
}

/**
 * Acquire the article HTML for a save. Precedence: provided HTML > plugin >
 * plugin with the user's credentials (when the caller opts in via `userAuth`) >
 * plain HTML fetch. Enforces maxSavedArticleSizeBytes on every path.
 */
async function acquireSavedArticleContent(
  userId: string,
  params: SaveArticleParams
): Promise<ArticleContentBundle & { contentUrl: string }> {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;

  if (params.html) {
    if (Buffer.byteLength(params.html, "utf8") > maxSize) {
      throw errors.contentTooLarge("Article", maxSize);
    }
    logger.debug("Using provided HTML for saved article", {
      url: params.url,
      htmlLength: params.html.length,
    });
    return {
      html: params.html,
      contentUrl: params.url,
      pluginContent: null,
      preCleanedContent: null,
    };
  }

  // Scope the try to the fetch itself. Every failure the fetch can raise — an
  // upstream error status, a network/DNS failure, a timeout, an SSRF block, an
  // unusable content type — is a problem with the user-provided URL, not a bug
  // in our server, so it maps to the client-facing SAVED_ARTICLE_FETCH_ERROR (a
  // 4xx that isn't reported to Sentry). Post-fetch processing (Markdown
  // conversion, Readability upstream) is deliberately OUTSIDE this catch: a
  // failure there is our bug and must surface as a 500 → Sentry, not be masked
  // as a "fetch error". A plugin's fetch with the user's credentials fails
  // already classified (a consent prompt) or with our bug, so it skips the
  // mapping too.
  const fetchUrl = normalizeSavedArticleUrl(params.url);
  let acquired: AcquiredArticle;
  try {
    acquired = await acquireArticleContent(fetchUrl, {
      asUser: params.userAuth ? { userId, authMode: params.userAuth } : undefined,
    });
  } catch (error) {
    if (error instanceof UserFetchError) {
      throw error.cause;
    }
    if (error instanceof TRPCError) {
      throw error;
    }
    logger.warn("Failed to fetch URL for saved article", {
      url: fetchUrl,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof ContentTooLargeError) {
      throw errors.contentTooLarge("Article", maxSize);
    }
    if (error instanceof HttpFetchError) {
      if (error.isRateLimited()) {
        throw errors.upstreamRateLimited(fetchUrl);
      }
      if (error.isBlocked()) {
        throw errors.siteBlocked(fetchUrl, error.status);
      }
    }
    // A feed shared to the PWA lands here (feeds are served as XML/JSON, which
    // the page fetch rejects). If it's really a feed, signal the caller to route
    // to Subscribe instead of failing the save.
    if (error instanceof InvalidContentTypeError) {
      if (await urlIsDirectFeed(fetchUrl, error.contentType)) {
        throw errors.urlIsFeed(fetchUrl);
      }
    }
    throw errors.savedArticleFetchError(
      fetchUrl,
      error instanceof Error ? error.message : "Unknown error"
    );
  }

  return articleContentFromAcquired(acquired, { offload: true });
}

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
 * Shape an already-saved row into a {@link SaveArticleResult} with outcome
 * `"existing"`, sanitizing the stored raw body per read off the event loop (raw
 * content must not leave the service layer).
 */
async function toExistingSavedArticle({
  entry,
  userState,
}: NonNullable<Awaited<ReturnType<typeof selectExistingSavedRow>>>): Promise<SaveArticleResult> {
  const { cleaned } = await sanitizeEntryContentFamily("content", {
    original: entry.contentOriginal,
    cleaned: entry.contentCleaned,
  });
  return {
    id: entry.id,
    url: entry.url!,
    title: entry.title,
    siteName: entry.siteName,
    author: entry.author,
    imageUrl: entry.imageUrl,
    contentCleaned: cleaned,
    excerpt: entry.summary,
    read: userState.read,
    starred: userState.starred,
    savedAt: entry.fetchedAt,
    outcome: "existing",
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
async function withCollections<T extends SavedArticle>(
  db: typeof dbType,
  userId: string,
  collectionIds: string[] = [],
  save: () => Promise<T>
): Promise<T> {
  await assertOwnedCollections(db, userId, collectionIds);
  const article = await save();
  await addEntryToCollections(db, userId, article.id, collectionIds);
  return article;
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
    entryId: saved.id,
    url: normalizedUrl,
    title: finalTitle,
  });

  return { ...saved, outcome: "created" };
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
      entryId: saved.id,
      url: normalizedUrl,
    });
    return { ...saved, outcome: "created" };
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
 * @returns true if deleted, false if not found
 */
export async function deleteSavedArticle(
  db: typeof dbType,
  userId: string,
  articleId: string
): Promise<boolean> {
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
    return false;
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
  });
  await publishEntryLeftCollections(db, userId, articleId, collectionIds);

  return true;
}

export interface UploadFileParams extends CollectionsParam {
  /** The file's bytes, base64-encoded. */
  content: string;
  /** The original filename: picks the converter, and is the last-resort title. */
  filename: string;
  title?: string;
}

/**
 * Enforces the saved article size limit on an upload's raw bytes, before any
 * conversion (mammoth, Readability, Markdown) can burn memory or CPU on it.
 */
function assertUploadSize(resource: string, bytes: number): void {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
  if (bytes > maxSize) {
    throw errors.contentTooLarge(resource, maxSize);
  }
}

/**
 * Save an uploaded file (.docx, .html, .md, .txt; see `convertUploadedFile`).
 *
 * The converted content runs through the same {@link buildArticleFields} pipeline
 * as a URL save — Readability, excerpt, and title/author/site-name precedence —
 * with a null URL and the filename as a last-resort title.
 */
export async function uploadFile(
  db: typeof dbType,
  userId: string,
  params: UploadFileParams
): Promise<SavedArticle> {
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
    return insertUploadedArticle(db, userId, fields);
  });
}

/**
 * Converts an uploaded file, reporting a file it can't read as the user's
 * error. An error that already knows what it is keeps its own code: Markdown
 * busting its byte budget is `CONTENT_TOO_LARGE` (#1431), not a bad file.
 */
async function convertUpload(file: Buffer, filename: string): Promise<ConvertedUpload> {
  try {
    return await convertUploadedFile(file, filename);
  } catch (error) {
    logger.warn("Failed to convert uploaded file", {
      filename,
      error: error instanceof Error ? error.message : String(error),
    });
    if (error instanceof TRPCError) throw error;
    const message = error instanceof Error ? error.message : "Unknown error";
    throw errors.validation(`Failed to process file: ${message}`);
  }
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
    return insertUploadedArticle(db, userId, fields);
  });
}
