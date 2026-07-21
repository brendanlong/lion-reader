/**
 * Saved Articles Service
 *
 * Business logic for saving articles. Used by both tRPC routers and MCP server.
 * Uses the plugin system for special URL handling (LessWrong, ArXiv, Google Docs, etc.).
 */

import { eq, and } from "drizzle-orm";
import { Parser } from "htmlparser2";
import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";
import type { db as dbType } from "@/server/db";
import { entries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { normalizeUrl } from "@/lib/url";
import {
  fetchHtmlPage,
  fetchUrl as fetchRawUrl,
  HttpFetchError,
  ContentTooLargeError,
  InvalidContentTypeError,
} from "@/server/http/fetch";
import { parseFeed } from "@/server/feed/parser";
import { processMarkdown } from "@/server/markdown";
import {
  titleFromFilename,
  type ConvertedUpload,
  type SupportedFileType,
} from "@/server/file/process-upload";
import { usageLimitsConfig } from "@/server/config/env";
import { absolutizeUrls, cleanContentAsync } from "@/server/feed/content-cleaner";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
import { getOrCreateSavedFeed, getSavedFeedId, SAVED_FEED_TITLE } from "@/server/feed/saved-feed";
import { generateSummary, stripHtml } from "@/server/html/strip-html";
import { computeSavedArticleExcerpt } from "@/server/services/saved-excerpt";
import { escapeHtml } from "@/server/http/html";
import { sanitizeEntryContentFamily } from "@/server/html/sanitize-entry";
import { logger } from "@/lib/logger";
import { publishNewEntry, publishEntryUpdatedFromEntry } from "@/server/redis/pubsub";
import { toNewEntryListData } from "@/lib/events/schemas";
import { errors } from "@/server/trpc/errors";
import { markEntriesRead } from "@/server/services/entries";
import { publishMarkReadStateChanges } from "@/server/services/entry-events";
import { pluginRegistry } from "@/server/plugins";
import {
  isGoogleDocsUrl,
  normalizeGoogleDocsUrl,
  fetchPrivateGoogleDoc,
  extractDocId,
  extractTabId,
  GOOGLE_DRIVE_SCOPE,
  type GoogleDocsContent,
} from "@/server/google/docs";
import { getOAuthAccount, hasGoogleScope, getValidGoogleToken } from "@/server/google/tokens";
import { GOOGLE_DOCS_READONLY_SCOPE } from "@/server/auth/oauth/google";

// ============================================================================
// Types
// ============================================================================

export interface SaveArticleParams {
  url: string;
  /** Optional title hint (useful when page title is poor) */
  title?: string;
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
   * Enable the private-Google-Docs auth flow: when a Google Docs URL can't be
   * fetched publicly, fetch it with the user's stored Google OAuth token
   * (requires a linked Google account with the Docs/Drive scopes granted). Both
   * modes attempt exactly the same token fetch; they differ only in how they
   * report "auth isn't set up yet":
   *
   * - `"interactive"` (web UI): throw the machine-readable NEEDS_GOOGLE_SIGNIN /
   *   NEEDS_DOCS_PERMISSION / NEEDS_GOOGLE_REAUTH errors the UI matches to drive
   *   an in-page consent prompt.
   * - `"non-interactive"` (Wallabag, MCP, and other API surfaces that can't run
   *   an interactive consent dance): throw the same 4xx classification but with a
   *   human-readable message pointing the user at the web app to complete the
   *   one-time Google authorization.
   *
   * Leave undefined for callers that shouldn't attempt private docs at all; they
   * fall back to a plain HTML fetch.
   */
  googleDocsAuth?: "interactive" | "non-interactive";
}

/** How a saveArticle call resolved. */
export type SaveArticleOutcome = "created" | "updated" | "existing";

export interface SaveArticleResult extends SavedArticle {
  outcome: SaveArticleOutcome;
}

export interface UploadArticleParams {
  /** Article content in Markdown format */
  content: string;
  /** Article title */
  title: string;
}

export interface CreateUploadedArticleParams {
  /** HTML content (already processed/cleaned) */
  contentHtml: string;
  /** Article title */
  title: string | null;
  /** Excerpt/summary (optional, will be generated from content if not provided) */
  excerpt?: string | null;
  /** Site name to display (e.g., "Uploaded Document", "Uploaded Markdown") */
  siteName: string;
  /** Author (optional) */
  author?: string | null;
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
   * Sanitized article body. Service results are returned verbatim by MCP
   * save_article and the Wallabag POST response, so raw fetched HTML must
   * never appear here.
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

/**
 * A unit of acquired content, however it was obtained. `saveArticle` fills it by
 * fetching a URL; the upload paths fill it by converting a file/Markdown. This is
 * the seam the "save vs. upload" difference collapses to: only acquisition (and a
 * null URL for uploads) differs — everything downstream is shared.
 */
interface ArticleContentBundle {
  /** Raw content HTML (stored as content_original). */
  html: string;
  /** Base URL for metadata + relative-URL resolution; null for uploads (no origin). */
  contentUrl: string | null;
  /** Plugin-supplied content that bypasses normal metadata/Readability sources. */
  pluginContent: {
    html: string;
    title?: string | null;
    author?: string | null;
    /** Plugin-supplied excerpt (e.g. arXiv API abstract); preferred over Readability's. */
    excerpt?: string | null;
    siteName?: string;
    skipReadability?: boolean;
  } | null;
  /**
   * Pre-cleaned content whose Readability is skipped because the source is
   * already clean: Markdown (frontmatter title/summary/author) or a `.docx`
   * (mammoth body + `docProps/core.xml` metadata). Null when Readability should
   * run (URL/HTML).
   */
  preCleanedContent: {
    html: string;
    title: string | null;
    summary: string | null;
    author: string | null;
  } | null;
}

/** Caller-supplied hints that outrank (title) or backstop (filename) extraction. */
interface ArticleFieldHints {
  /** Explicit caller-provided title — highest precedence. */
  providedTitle?: string | null;
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
 *  - author: plugin / frontmatter / docx core.xml → Readability byline → OG/meta author
 *  - excerpt: see {@link computeSavedArticleExcerpt} (plugin excerpt → source metadata → cleaned → plugin/pre-cleaned HTML)
 */
async function buildArticleFields(
  bundle: ArticleContentBundle,
  hints: ArticleFieldHints = {},
  // Uploads are trusted user content, so they pass a lower minCleanedLength than
  // a web fetch (where a short extraction usually means a failed JS-heavy page).
  cleanOptions: { minCleanedLength?: number } = {}
): Promise<BuiltArticleFields> {
  const { html, contentUrl, pluginContent, preCleanedContent } = bundle;
  // Uploads have no origin; a guaranteed-broken base keeps relative URLs from
  // resolving against Lion Reader itself.
  const baseUrl = contentUrl ?? UPLOAD_BASE_URL;

  // Extract metadata from Open Graph / meta tags.
  const metadata = extractMetadata(html, baseUrl);

  // Run Readability unless a plugin opted out or the content is already clean
  // (Markdown / docx). Extraction runs on the libuv thread pool so large pages
  // don't block the event loop.
  const shouldSkipReadability =
    Boolean(pluginContent?.skipReadability) || preCleanedContent !== null;
  const cleaned = shouldSkipReadability
    ? null
    : await cleanContentAsync(html, { url: baseUrl, ...cleanOptions });

  // When Readability ran, its output already has absolutized URLs; when it was
  // skipped for plugin/pre-cleaned content, absolutize here. When neither produced
  // anything (Readability failed on a plain page), store NULL rather than the raw
  // full page — readers fall back to the sanitized original content.
  const contentCleaned =
    preCleanedContent?.html ??
    cleaned?.content ??
    (pluginContent ? absolutizeUrls(pluginContent.html, baseUrl) : null);

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
  // Today our extractor (dom_smoothie) doesn't clean the title beyond the
  // meta/<title> scrape, so title is equivalent either way in practice — but this
  // is the order we want if/when it improves.
  const title =
    hints.providedTitle ||
    pluginContent?.title ||
    preCleanedContent?.title ||
    cleaned?.title ||
    metadata.title ||
    (hints.filename ? titleFromFilename(hints.filename) || null : null) ||
    null;
  const author =
    pluginContent?.author ||
    preCleanedContent?.author ||
    cleaned?.byline ||
    metadata.author ||
    null;
  const siteName = hints.siteName || pluginContent?.siteName || metadata.siteName || null;

  const summary = computeSavedArticleExcerpt({ preCleanedContent, cleaned, pluginContent, html });

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
    contentOriginal: html,
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
 * `onConflictDoNothing` on `(feed_id, guid)`, so a concurrent duplicate save
 * (e.g. a double-click) is idempotent instead of surfacing a raw unique-violation
 * 500 (issue #952). The caller re-selects the existing article in that case.
 * Uploads use a random `uploaded:{uuid}` guid, so they never conflict and always
 * get a row back.
 */
async function insertSavedEntry(
  db: typeof dbType,
  userId: string,
  savedFeedId: string,
  params: InsertSavedEntryParams
): Promise<SavedArticle | null> {
  const now = new Date();
  const entryId = generateUuidv7();

  // Store only the raw columns; the read path sanitizes per read (issue #1282).
  const values = {
    id: entryId,
    feedId: savedFeedId,
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
      .onConflictDoNothing({ target: [entries.feedId, entries.guid] })
      .returning({ id: entries.id });

    // Conflict: another save already created this (feed_id, guid). Abort so the
    // caller can return the existing article idempotently.
    if (insertedRows.length === 0) {
      return false;
    }

    await tx.insert(userEntries).values({
      userId,
      entryId,
      read: false,
      starred: false,
    });
    return true;
  });

  if (!inserted) {
    return null;
  }

  // Fire-and-forget: SSE is best-effort and must never fail the save response
  // (the entry transaction has already committed). See entry-events.ts.
  void publishNewEntry(
    savedFeedId,
    entryId,
    now,
    "saved",
    toNewEntryListData(values, SAVED_FEED_TITLE)
  ).catch(() => {});

  // Sanitize the body for the returned SavedArticle: it is returned verbatim by
  // service consumers (MCP save_article, Wallabag POST), so raw fetched HTML must
  // not leave the service layer here either.
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
interface UploadedArticleFields {
  title: string | null;
  author: string | null;
  siteName: string | null;
  contentOriginal: string;
  contentCleaned: string | null;
  summary: string | null;
  imageUrl: string | null;
  contentHash: string;
}

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
  if (fields.contentOriginal.length > maxSize) {
    throw errors.contentTooLarge("Uploaded article", maxSize);
  }

  const savedFeedId = await getOrCreateSavedFeed(db, userId);

  // Fresh random guid → the insert can't conflict.
  const guid = `uploaded:${generateUuidv7()}`;

  const saved = await insertSavedEntry(db, userId, savedFeedId, {
    guid,
    url: null,
    title: fields.title,
    author: fields.author,
    contentOriginal: fields.contentOriginal,
    contentCleaned: fields.contentCleaned,
    summary: fields.summary,
    siteName: fields.siteName,
    imageUrl: fields.imageUrl,
    contentHash: fields.contentHash,
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
 * Human-readable messages for the `"non-interactive"` auth flow (Wallabag, MCP,
 * and other API surfaces that can't run an in-page consent dance). The
 * `"interactive"` flow instead throws the machine-readable NEEDS_* codes the web
 * UI matches — both share the same 4xx classification, so Wallabag's
 * `clientErrorResponse` and MCP surface either one cleanly.
 */
const NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES = {
  signin:
    "This is a private Google Doc. To save private Google Docs from the API, first link your Google account and authorize Google Docs access in the Lion Reader web app (by saving a Google Doc there once).",
  permission:
    "This is a private Google Doc. To save it from the API, grant Google Docs access in the Lion Reader web app first (by saving a Google Doc there once).",
  reauth:
    "Your Google authorization has expired. Please reconnect your Google account in the Lion Reader web app, then try saving again.",
} as const;

/**
 * Fetch a private Google Doc with the user's stored OAuth credentials.
 *
 * When no Google account is linked or the required scopes aren't granted, throws
 * a 4xx error. The `mode` only controls the *message*:
 * - `"interactive"` throws the machine-readable NEEDS_GOOGLE_SIGNIN /
 *   NEEDS_DOCS_PERMISSION / NEEDS_GOOGLE_REAUTH codes the web UI turns into
 *   consent prompts.
 * - `"non-interactive"` throws the same UNAUTHORIZED/FORBIDDEN classification
 *   with a human-readable message telling API clients to complete the one-time
 *   authorization in the web app.
 *
 * Returns null (caller falls back to a plain HTML fetch) when the doc can't be
 * fetched for other reasons.
 */
async function fetchPrivateGoogleDocWithAuth(
  userId: string,
  normalizedUrl: string,
  mode: "interactive" | "non-interactive"
): Promise<GoogleDocsContent | null> {
  const docId = extractDocId(normalizedUrl);
  if (!docId) {
    return null;
  }
  const tabId = extractTabId(normalizedUrl);

  const googleOAuth = await getOAuthAccount(userId, "google");
  if (!googleOAuth) {
    logger.debug("User needs to sign in with Google for private docs", {
      userId,
      url: normalizedUrl,
      mode,
    });
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message:
        mode === "interactive"
          ? "NEEDS_GOOGLE_SIGNIN"
          : NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES.signin,
      cause: {
        code: "NEEDS_GOOGLE_SIGNIN",
        details: {
          url: normalizedUrl,
        },
      },
    });
  }

  // Check if user has granted both required scopes:
  // - documents.readonly for native Google Docs via Docs API
  // - drive.readonly for uploaded .docx files via Drive API
  const [hasDocsApiScope, hasDriveScope] = await Promise.all([
    hasGoogleScope(userId, GOOGLE_DOCS_READONLY_SCOPE),
    hasGoogleScope(userId, GOOGLE_DRIVE_SCOPE),
  ]);

  if (!hasDocsApiScope || !hasDriveScope) {
    logger.debug("User needs to grant Google Docs permissions", {
      userId,
      url: normalizedUrl,
      hasDocsApiScope,
      hasDriveScope,
      mode,
    });
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        mode === "interactive"
          ? "NEEDS_DOCS_PERMISSION"
          : NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES.permission,
      cause: {
        code: "NEEDS_DOCS_PERMISSION",
        details: {
          url: normalizedUrl,
          scopes: [GOOGLE_DOCS_READONLY_SCOPE, GOOGLE_DRIVE_SCOPE],
        },
      },
    });
  }

  try {
    logger.debug("Attempting private Google Docs fetch with user OAuth", { userId, docId });
    const accessToken = await getValidGoogleToken(userId);
    return await fetchPrivateGoogleDoc(docId, accessToken, tabId);
  } catch (error) {
    if (error instanceof Error && error.message === "GOOGLE_TOKEN_INVALID") {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message:
          mode === "interactive"
            ? "Google authentication expired. Please reconnect your Google account."
            : NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES.reauth,
      });
    } else if (error instanceof Error && error.message === "GOOGLE_PERMISSION_DENIED") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You don't have permission to access this Google Doc.",
      });
    } else if (error instanceof Error && error.message === "GOOGLE_NEEDS_REAUTH") {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message:
          mode === "interactive"
            ? "NEEDS_GOOGLE_REAUTH"
            : NON_INTERACTIVE_GOOGLE_DOCS_MESSAGES.reauth,
        cause: {
          code: "NEEDS_GOOGLE_REAUTH",
          details: {
            url: normalizedUrl,
          },
        },
      });
    }
    // Other errors - fall back to a plain fetch
    logger.warn("Failed to fetch private Google Doc with OAuth", {
      userId,
      docId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

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

/** True for errors created by errors.contentTooLarge. */
function isContentTooLargeError(error: unknown): boolean {
  return (
    error instanceof TRPCError &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    (error.cause as { code?: unknown }).code === "CONTENT_TOO_LARGE"
  );
}

interface AcquiredArticleContent {
  /** Raw page/document HTML (stored as content_original). */
  html: string;
  /**
   * The URL the content was actually fetched from (after redirects).
   * Used for resolving relative URLs in the content.
   */
  contentUrl: string;
  /** Content supplied by a plugin (incl. Google Docs); skips normal metadata sources. */
  pluginContent: {
    html: string;
    title?: string | null;
    author?: string | null;
    /** Plugin-supplied excerpt (e.g. arXiv API abstract); preferred over Readability's. */
    excerpt?: string | null;
    siteName?: string;
    skipReadability?: boolean;
  } | null;
  /**
   * Pre-cleaned content whose Readability is skipped (Markdown frontmatter here);
   * null for a normal HTML fetch. See {@link ArticleContentBundle.preCleanedContent}.
   */
  preCleanedContent: {
    html: string;
    title: string | null;
    summary: string | null;
    author: string | null;
  } | null;
}

/**
 * Acquire the article HTML for a save. Precedence: provided HTML > plugin
 * (incl. public Google Docs) > private Google Docs OAuth (when the caller
 * opts in via `googleDocsAuth`) > plain HTML fetch. Enforces
 * maxSavedArticleSizeBytes on every path.
 */
async function acquireArticleContent(
  userId: string,
  params: SaveArticleParams,
  normalizedUrl: string
): Promise<AcquiredArticleContent> {
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;

  if (params.html) {
    if (params.html.length > maxSize) {
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

  // Try to find a plugin for this URL (public Google Docs, LessWrong, ArXiv, …)
  let urlObj: URL | null = null;
  try {
    urlObj = new URL(params.url);
  } catch {
    // Invalid URL, continue to normal fetch
  }

  const plugin = urlObj ? pluginRegistry.findWithCapability(urlObj, "savedArticle") : null;

  if (plugin) {
    logger.debug("Attempting plugin fetch for saved article", {
      url: params.url,
      plugin: plugin.name,
    });

    try {
      const content = await plugin.capabilities.savedArticle.fetchContent(urlObj!, {});
      if (content) {
        // Check plugin content size
        if (content.html.length > maxSize) {
          throw errors.contentTooLarge("Article", maxSize);
        }

        logger.debug("Successfully fetched content via plugin", {
          url: params.url,
          plugin: plugin.name,
          title: content.title,
        });
        return {
          html: content.html,
          contentUrl: content.canonicalUrl ?? params.url,
          pluginContent: {
            html: content.html,
            title: content.title,
            author: content.author,
            excerpt: content.excerpt,
            siteName: plugin.capabilities.savedArticle.siteName,
            skipReadability: plugin.capabilities.savedArticle.skipReadability,
          },
          preCleanedContent: null,
        };
      }
    } catch (error) {
      // A size-limit violation is a hard failure — surfacing it beats
      // silently degrading to a plain scrape of the same oversized page.
      if (isContentTooLargeError(error)) {
        throw error;
      }
      // Rate limit errors should not fall back to a normal fetch — the same
      // site would rate limit us again.
      if (error instanceof HttpFetchError && error.isRateLimited()) {
        logger.warn("Plugin fetch rate limited", {
          url: params.url,
          plugin: plugin.name,
          status: error.status,
        });
        throw errors.upstreamRateLimited(params.url);
      }
      logger.warn("Plugin fetch failed, falling back to normal fetch", {
        url: params.url,
        plugin: plugin.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Private Google Docs: the plugin only fetches public docs. When the caller
  // opts in, try the user's stored OAuth credentials. This needs no
  // interactivity once the account is linked and the scopes are granted, so
  // the compat surfaces (Wallabag/MCP) use "non-interactive" mode — the only
  // difference is the message thrown when auth isn't set up yet.
  if (params.googleDocsAuth && isGoogleDocsUrl(params.url)) {
    const googleDocsContent = await fetchPrivateGoogleDocWithAuth(
      userId,
      normalizedUrl,
      params.googleDocsAuth
    );
    if (googleDocsContent) {
      if (googleDocsContent.html.length > maxSize) {
        throw errors.contentTooLarge("Article", maxSize);
      }
      logger.debug("Successfully fetched private Google Docs content", {
        userId,
        docId: googleDocsContent.docId,
        title: googleDocsContent.title,
      });
      return {
        // Bare fragment — a wrapped document would leak the <title> text
        // into the sanitized body (see SavedArticleContent in plugins/types.ts)
        html: googleDocsContent.html,
        contentUrl: normalizedUrl,
        pluginContent: {
          html: googleDocsContent.html,
          title: googleDocsContent.title,
          author: googleDocsContent.author,
          siteName: "Google Docs",
          skipReadability: true,
        },
        preCleanedContent: null,
      };
    }
  }

  // Fall back to a normal HTML fetch.
  // For Google Docs use the normalized URL for consistent fetching.
  const fetchUrl = isGoogleDocsUrl(params.url) ? normalizedUrl : params.url;

  // Scope the try to the fetch itself. Every failure `fetchHtmlPage` can raise —
  // an upstream error status, a network/DNS failure, a timeout, an SSRF block,
  // an unusable content type — is a problem with the user-provided URL, not a
  // bug in our server, so it maps to the client-facing SAVED_ARTICLE_FETCH_ERROR
  // (a 4xx that isn't reported to Sentry). Post-fetch processing (Markdown
  // conversion, Readability upstream) is deliberately OUTSIDE this catch: a
  // failure there is our bug and must surface as a 500 → Sentry, not be masked
  // as a "fetch error".
  let result;
  try {
    result = await fetchHtmlPage(fetchUrl);
  } catch (error) {
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

  // If we got Markdown, convert it to HTML and extract title
  if (result.isMarkdown) {
    logger.debug("Converting Markdown to HTML for saved article (will skip Readability)", {
      url: fetchUrl,
    });
    const markdownResult = await processMarkdown(result.content);
    return {
      html: markdownResult.html,
      contentUrl: result.finalUrl,
      pluginContent: null,
      preCleanedContent: markdownResult,
    };
  }
  return {
    html: result.content,
    contentUrl: result.finalUrl,
    pluginContent: null,
    preCleanedContent: null,
  };
}

/**
 * Save a URL for later reading.
 *
 * Fetches the URL (or uses caller-provided HTML), extracts metadata and clean
 * content via Readability, and stores it as a saved article. If the URL is
 * already saved, returns the existing article — or, with `refetch`, updates
 * it in place (guarded by a content-quality comparison unless `force`).
 *
 * Uses the plugin system for special URL handling (LessWrong, ArXiv, public
 * Google Docs, etc.); private Google Docs are supported via the
 * `googleDocsAuth` option (interactive for the web UI, non-interactive for the
 * Wallabag/MCP compat surfaces).
 */
/**
 * Normalizes a URL exactly the way {@link saveArticle} does before storing it as
 * the entry `guid`: strip fragments (two URLs differing only by `#section` point
 * to the same article), and for Google Docs remove extraneous query params
 * except `tab`. Existence checks must use this so they match saved rows.
 */
function normalizeSavedUrl(url: string): string {
  const normalized = normalizeUrl(url);
  return isGoogleDocsUrl(normalized) ? normalizeGoogleDocsUrl(normalized) : normalized;
}

/**
 * Checks whether the user has already saved an article for the given URL,
 * returning its entry id (or null). Read-only: unlike {@link saveArticle} it
 * never creates the user's saved feed, so it's safe on probe/exists paths.
 *
 * Indexed by the `uq_entries_feed_guid` unique constraint on `(feed_id, guid)`.
 */
export async function savedArticleExistsByUrl(
  db: typeof dbType,
  userId: string,
  url: string
): Promise<string | null> {
  const savedFeedId = await getSavedFeedId(db, userId);
  if (!savedFeedId) return null;

  const normalizedUrl = normalizeSavedUrl(url);
  const existing = await db
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.feedId, savedFeedId),
        eq(entries.guid, normalizedUrl),
        eq(userEntries.userId, userId)
      )
    )
    .limit(1);

  return existing[0]?.id ?? null;
}

/**
 * Re-select an already-saved article for this (user, normalized URL) and shape
 * it into a {@link SaveArticleResult} with outcome `"existing"`, version-healing
 * the sanitized body off the event loop (raw content must not leave the service
 * layer). Returns null if no such row exists.
 *
 * Shared by {@link saveArticle}'s post-conflict idempotent return and
 * {@link savePlaceholderArticle}'s conflict fallback — both of which need the
 * existing row **without** triggering a refetch (savePlaceholderArticle must
 * not, since a placeholder now always refetches on the normal saveArticle path).
 */
async function selectExistingSavedArticle(
  db: typeof dbType,
  userId: string,
  savedFeedId: string,
  normalizedUrl: string
): Promise<SaveArticleResult | null> {
  const [row] = await db
    .select({ entry: entries, userState: userEntries })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.feedId, savedFeedId),
        eq(entries.guid, normalizedUrl),
        eq(userEntries.userId, userId)
      )
    )
    .limit(1);
  if (!row) {
    return null;
  }
  const { entry, userState } = row;
  // Sanitize the stored raw body per read, offloading large bodies to the
  // worker pool (matches the no-refetch path).
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

export async function saveArticle(
  db: typeof dbType,
  userId: string,
  params: SaveArticleParams
): Promise<SaveArticleResult> {
  const normalizedUrl = normalizeSavedUrl(params.url);

  // Get or create the user's saved feed
  const savedFeedId = await getOrCreateSavedFeed(db, userId);

  // Check if URL is already saved (guid = normalized URL for saved articles)
  const existing = await db
    .select({
      entry: entries,
      userState: userEntries,
    })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.feedId, savedFeedId),
        eq(entries.guid, normalizedUrl),
        eq(userEntries.userId, userId)
      )
    )
    .limit(1);

  // Track existing entry for the refetch comparison
  let existingEntry: (typeof existing)[0] | null = null;

  if (existing.length > 0) {
    // A placeholder (a failed-save stand-in, see savePlaceholderArticle) always
    // refetches on re-save so a transiently-failed URL self-heals into the real
    // article — even for the no-refetch callers (a plain Wallabag re-share, MCP
    // save_article). A real saved article still returns instantly unless the
    // caller opted into refetch. See #1256.
    const isPlaceholder = existing[0].entry.isPlaceholder;
    if (!params.refetch && !isPlaceholder) {
      const { entry, userState } = existing[0];
      // Sanitize the stored raw body per read, offloading large bodies to the
      // worker pool so it doesn't block the event loop (raw content must not
      // leave the service layer) — matching entries.get.
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
    // refetch=true (or a placeholder): continue to fetch new content and compare
    existingEntry = existing[0];
  }

  const bundle = await acquireArticleContent(userId, params, normalizedUrl);
  const { html } = bundle;

  // Derive the stored fields from the acquired content. Shared with the upload
  // paths (buildArticleFields) so save and upload stay in lockstep.
  const {
    title: finalTitle,
    author: finalAuthor,
    siteName: finalSiteName,
    contentCleaned: finalContentCleaned,
    summary: excerpt,
    imageUrl,
    contentHash,
    newTextContent,
  } = await buildArticleFields(bundle, { providedTitle: params.title ?? null });

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
          message: "REFETCH_CONTENT_WORSE",
          cause: {
            code: "REFETCH_CONTENT_WORSE",
            details: {
              url: normalizedUrl,
              oldLength: oldTextLength,
              newLength: newTextLength,
              hint: "The refetched content appears significantly shorter than the original. This often happens when a private document is refetched without authentication. Use force=true to override.",
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
      contentOriginal: html,
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
    // unread flip is routed through markEntriesRead (rather than a bare
    // `read=false` UPDATE) so it maintains read_changed_at (the changedAt
    // idempotency contract — otherwise a stale queued offline "mark read" older
    // than this refetch would win later) and bumps updated_at (so sync.events
    // reports it to offline clients). Both writes share one transaction so a
    // crash can't leave new content with the old read state. Publishing is
    // suppressed inside the tx and done after commit (below) so a rolled-back
    // mark can't emit a phantom entry_state_changed event.
    const { changed: readChanged, counts: readCounts } = await db.transaction(async (tx) => {
      await tx.update(entries).set(update).where(eq(entries.id, oldEntry.id));
      return markEntriesRead(tx, userId, [{ id: oldEntry.id, changedAt: now }], false, {
        publish: false,
      });
    });

    // Post-commit: notify other tabs of the unread flip + refreshed counts.
    // Both are absent when the article was already unread (a re-save flips
    // nothing) — nothing to publish then.
    if (readChanged.length > 0 && readCounts) {
      publishMarkReadStateChanges(db, userId, readChanged, readCounts);
    }

    logger.info("Refetched saved article", {
      entryId: oldEntry.id,
      url: normalizedUrl,
      forced: params.force ?? false,
    });

    // Publish event to notify other browser windows/tabs of the content update.
    // Fire-and-forget: SSE is best-effort and must never fail the response (the
    // transaction has already committed). See entry-events.ts.
    void publishEntryUpdatedFromEntry(savedFeedId, {
      id: oldEntry.id,
      title: finalTitle,
      author: finalAuthor,
      summary: excerpt,
      url: normalizedUrl,
      publishedAt: oldEntry.publishedAt,
      updatedAt: now,
    }).catch(() => {});

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

  const saved = await insertSavedEntry(db, userId, savedFeedId, {
    guid: normalizedUrl,
    url: normalizedUrl,
    title: finalTitle,
    author: finalAuthor,
    contentOriginal: html,
    contentCleaned: finalContentCleaned,
    summary: excerpt,
    siteName: finalSiteName,
    imageUrl,
    contentHash,
  });

  // A concurrent save (e.g. a double-click) already inserted this (feed_id,
  // guid) between our existence check above and the insert. Return the existing
  // article idempotently instead of surfacing a unique-violation 500 (#952).
  if (!saved) {
    const existingResult = await selectExistingSavedArticle(db, userId, savedFeedId, normalizedUrl);
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
 * no-refetch callers — a plain Wallabag re-share, MCP `save_article`) and, on
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
  const savedFeedId = await getOrCreateSavedFeed(db, userId);

  // The placeholder body is our own short, trusted text; escape the reason (it
  // embeds the failing URL / upstream message) so it can't inject markup. It's
  // sanitized again at write time by insertSavedEntry regardless.
  const body = `<p>Lion Reader couldn't save this page.</p><p>${escapeHtml(params.reason)}</p>`;
  const contentHash = generateContentHash(params.url, body);

  const saved = await insertSavedEntry(db, userId, savedFeedId, {
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

  // The (feed_id, guid) already exists: this URL was previously saved (a real
  // article or an earlier placeholder), or two queued retries raced. Return the
  // existing entry idempotently instead of a unique-violation.
  //
  // Deliberately re-select directly rather than calling saveArticle: a
  // placeholder now always *refetches* on the saveArticle path, and a refetch
  // that fails again would throw here — breaking this surface's contract of
  // draining the Wallabag queue with a 200. (This is reached only after our own
  // insert lost a race with an existing row, so a fresh fetch here would be
  // wasted work anyway.)
  const existingResult = await selectExistingSavedArticle(db, userId, savedFeedId, normalizedUrl);
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
  // Read-only lookup: deleting can never need to create the saved feed, so avoid
  // the write side effect. No saved feed → nothing to delete (matches
  // savedArticleExistsByUrl).
  const savedFeedId = await getSavedFeedId(db, userId);
  if (!savedFeedId) return false;

  // Verify the article exists and belongs to the user's saved feed
  const existing = await db
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(
      and(
        eq(entries.id, articleId),
        eq(entries.feedId, savedFeedId),
        eq(userEntries.userId, userId)
      )
    )
    .limit(1);

  if (existing.length === 0) {
    return false;
  }

  // Delete the entry (will cascade to user_entries). Scope the DELETE to the
  // user's own saved feed as well as the id — the ownership SELECT above already
  // guarantees it, but pinning feedId keeps the mutation self-evidently
  // user-scoped in isolation (defense-in-depth against a future refactor).
  await db.delete(entries).where(and(eq(entries.id, articleId), eq(entries.feedId, savedFeedId)));

  return true;
}

/**
 * Create a saved article from pre-processed HTML content.
 *
 * Accepts already-cleaned HTML plus caller-supplied metadata and inserts it
 * as-is (no Readability, no metadata extraction) — for callers that already hold
 * final content. The file/Markdown upload entry points instead run their content
 * through {@link buildArticleFields} (see {@link createSavedFromUpload} /
 * {@link uploadArticle}).
 */
export async function createUploadedArticle(
  db: typeof dbType,
  userId: string,
  params: CreateUploadedArticleParams
): Promise<SavedArticle> {
  // Original and cleaned are the same string here; stored raw and sanitized per
  // read (issue #1282).
  return insertUploadedArticle(db, userId, {
    title: params.title,
    author: params.author ?? null,
    siteName: params.siteName,
    contentOriginal: params.contentHtml,
    contentCleaned: params.contentHtml,
    summary: params.excerpt ?? generateSummary(params.contentHtml) ?? null,
    imageUrl: null,
    contentHash: generateContentHash(params.title, params.contentHtml),
  });
}

/**
 * Create a saved article from an uploaded file (see `convertUploadedFile`).
 *
 * The converted content runs through the same {@link buildArticleFields} pipeline
 * as a URL save — Readability, excerpt, and title/author/site-name precedence —
 * with a null URL and the filename as a last-resort title.
 */
export async function createSavedFromUpload(
  db: typeof dbType,
  userId: string,
  params: { converted: ConvertedUpload; title?: string | null }
): Promise<SavedArticle> {
  const { converted } = params;
  const fields = await buildArticleFields(
    {
      html: converted.html,
      contentUrl: null,
      pluginContent: null,
      preCleanedContent: converted.preCleanedContent,
    },
    {
      providedTitle: params.title ?? null,
      filename: converted.filename,
      siteName: UPLOAD_SITE_NAMES[converted.fileType],
    },
    { minCleanedLength: 10 }
  );
  return insertUploadedArticle(db, userId, fields);
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
  // Check raw content size before processing
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
  if (params.content.length > maxSize) {
    throw errors.contentTooLarge("Uploaded article", maxSize);
  }

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
    { providedTitle: params.title, siteName: "Uploaded Article" }
  );
  return insertUploadedArticle(db, userId, fields);
}
