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
import { fetchHtmlPage, HttpFetchError, ContentTooLargeError } from "@/server/http/fetch";
import { processMarkdown } from "@/server/markdown";
import { usageLimitsConfig } from "@/server/config/env";
import { extractTextFromHtml } from "@/server/http/html";
import { absolutizeUrls } from "@/server/feed/content-cleaner";
import { cleanContentInWorker, sanitizeEntryHtmlInWorker } from "@/server/worker-thread/pool";
import { getOrCreateSavedFeed, getSavedFeedId, SAVED_FEED_TITLE } from "@/server/feed/saved-feed";
import { generateSummary } from "@/server/html/strip-html";
import { withSanitizedEntryContentAsync } from "@/server/html/sanitize-entry";
import { logger } from "@/lib/logger";
import { publishNewEntry, publishEntryUpdatedFromEntry } from "@/server/redis/pubsub";
import { toNewEntryListData } from "@/lib/events/schemas";
import { errors } from "@/server/trpc/errors";
import { markEntriesRead, resolveSanitizedFamily } from "@/server/services/entries";
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
   * Enable the interactive private-Google-Docs auth flow: when a Google Docs
   * URL can't be fetched publicly, throw NEEDS_GOOGLE_SIGNIN /
   * NEEDS_DOCS_PERMISSION / NEEDS_GOOGLE_REAUTH errors that the web UI turns
   * into consent prompts (or fetch with the user's OAuth token when already
   * granted). Leave off for non-interactive callers (MCP), which fall back to
   * a plain HTML fetch.
   */
  googleDocsAuth?: boolean;
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
}

/**
 * Insert a saved entry into the database and publish a new-entry event.
 *
 * Handles the shared boilerplate for both saveArticle and createUploadedArticle:
 * entry insert, user_entries insert, SSE publish, and SavedArticle construction.
 *
 * The entry and user_entries inserts run in one transaction so a crash can't
 * leave an entry with no user_entries row (which would make it invisible).
 *
 * Returns null when the entry already exists — the entry insert uses
 * `onConflictDoNothing` on `(feed_id, guid)`, so a concurrent duplicate save
 * (e.g. a double-click) is idempotent instead of surfacing a raw unique-violation
 * 500 (issue #952). The caller re-selects the existing article in that case.
 * `createUploadedArticle` uses a random `uploaded:{uuid}` guid, so it never
 * conflicts and always gets a row back.
 */
async function insertSavedEntry(
  db: typeof dbType,
  userId: string,
  savedFeedId: string,
  params: InsertSavedEntryParams,
  presanitized?: {
    contentOriginalSanitized?: string | null;
    contentCleanedSanitized?: string | null;
  }
): Promise<SavedArticle | null> {
  const now = new Date();
  const entryId = generateUuidv7();

  // Sanitize at write time so entries.get serves saved articles without
  // re-running sanitize-html on every read. Offloaded to a worker thread for
  // large bodies (this runs on the app-server request path); `presanitized`
  // reuses any sanitization the caller already computed (e.g. in the
  // cleanContent worker) instead of repeating it.
  const values = await withSanitizedEntryContentAsync(
    {
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
    },
    presanitized ?? {}
  );
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

  return {
    id: entryId,
    url: params.url,
    title: params.title,
    siteName: params.siteName,
    author: params.author,
    imageUrl: params.imageUrl,
    // Serve the sanitized body: SavedArticle is returned verbatim by service
    // consumers (MCP save_article, Wallabag POST), so raw fetched HTML must
    // not leave the service layer here either.
    contentCleaned: values.contentCleanedSanitized ?? null,
    excerpt: params.summary,
    read: false,
    starred: false,
    savedAt: now,
  };
}

// ============================================================================
// Service Functions
// ============================================================================

/**
 * Fetch a private Google Doc with the user's OAuth credentials (the
 * interactive `googleDocsAuth` flow).
 *
 * Throws NEEDS_GOOGLE_SIGNIN when no Google account is linked and
 * NEEDS_DOCS_PERMISSION when the required scopes haven't been granted — the
 * web UI turns these into consent prompts. Returns null (caller falls back to
 * a plain HTML fetch) when the doc can't be fetched for other reasons.
 */
async function fetchPrivateGoogleDocWithAuth(
  userId: string,
  normalizedUrl: string
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
    });
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "NEEDS_GOOGLE_SIGNIN",
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
    });
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "NEEDS_DOCS_PERMISSION",
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
        message: "Google authentication expired. Please reconnect your Google account.",
      });
    } else if (error instanceof Error && error.message === "GOOGLE_PERMISSION_DENIED") {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "You don't have permission to access this Google Doc.",
      });
    } else if (error instanceof Error && error.message === "GOOGLE_NEEDS_REAUTH") {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "NEEDS_GOOGLE_REAUTH",
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
    siteName?: string;
    skipReadability?: boolean;
  } | null;
  /** Markdown processing results (Readability is skipped for Markdown). */
  markdownResult: {
    html: string;
    title: string | null;
    summary: string | null;
    author: string | null;
  } | null;
}

/**
 * Acquire the article HTML for a save. Precedence: provided HTML > plugin
 * (incl. public Google Docs) > private Google Docs OAuth (interactive
 * callers) > plain HTML fetch. Enforces maxSavedArticleSizeBytes on every
 * path.
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
    return { html: params.html, contentUrl: params.url, pluginContent: null, markdownResult: null };
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
            siteName: plugin.capabilities.savedArticle.siteName,
            skipReadability: plugin.capabilities.savedArticle.skipReadability,
          },
          markdownResult: null,
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

  // Private Google Docs: the plugin only fetches public docs. For
  // interactive callers, try the user's OAuth credentials (throws NEEDS_*
  // errors the web UI converts into consent prompts).
  if (params.googleDocsAuth && isGoogleDocsUrl(params.url)) {
    const googleDocsContent = await fetchPrivateGoogleDocWithAuth(userId, normalizedUrl);
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
        markdownResult: null,
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
      markdownResult,
    };
  }
  return {
    html: result.content,
    contentUrl: result.finalUrl,
    pluginContent: null,
    markdownResult: null,
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
 * Google Docs, etc.); private Google Docs are supported via the interactive
 * `googleDocsAuth` option.
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
    if (!params.refetch) {
      const { entry, userState } = existing[0];
      // Serve the stored sanitized body, healing it off the event loop if the
      // stored SANITIZER_VERSION is behind (raw content must not leave the
      // service layer). resolveSanitizedFamily version-checks, offloads large
      // sanitizes to the worker pool, and self-heals — matching entries.get.
      const { cleaned } = await resolveSanitizedFamily(db, entry.id, "content", {
        originalSanitized: entry.contentOriginalSanitized,
        cleanedSanitized: entry.contentCleanedSanitized,
        version: entry.contentSanitizedVersion,
        hasRaw: entry.contentOriginal !== null || entry.contentCleaned !== null,
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
    // refetch=true: continue to fetch new content and compare
    existingEntry = existing[0];
  }

  const { html, contentUrl, pluginContent, markdownResult } = await acquireArticleContent(
    userId,
    params,
    normalizedUrl
  );

  // Extract metadata from Open Graph / meta tags
  const metadata = extractMetadata(html, contentUrl);

  // Run Readability for clean content (skip for plugins that request it, or
  // for Markdown). Runs in a worker thread so large pages don't block the
  // event loop.
  const shouldSkipReadability = Boolean(pluginContent?.skipReadability) || markdownResult !== null;
  const cleaned = shouldSkipReadability
    ? null
    : // sanitizeCleaned: also sanitize the cleaned HTML in the same worker task,
      // so persisting it below doesn't ship the string back across the thread
      // boundary a second time just to sanitize it.
      await cleanContentInWorker(html, { url: contentUrl }, { sanitizeCleaned: true });

  // Generate excerpt - prefer frontmatter summary for Markdown content
  let excerpt: string | null = null;
  if (markdownResult?.summary) {
    // Use summary from frontmatter
    excerpt = markdownResult.summary;
  } else if (pluginContent) {
    excerpt = generateSummary(pluginContent.html) || null;
  } else if (markdownResult) {
    excerpt = generateSummary(html) || null;
  } else if (cleaned) {
    excerpt = cleaned.excerpt || cleaned.textContent.slice(0, 300).trim() || null;
    if (excerpt && excerpt.length > 300) {
      excerpt = excerpt.slice(0, 297) + "...";
    }
  }

  // Build final values - prefer plugin/API data, then provided hint, then
  // extracted metadata, then Readability
  // When Readability ran, its output already has absolutized URLs; when it
  // was skipped for plugin/API content, absolutize here.
  // When neither produced anything (Readability failed on a plain page),
  // store NULL rather than the raw full page — readers fall back to the
  // sanitized original content.
  const finalContentCleaned =
    markdownResult?.html ??
    cleaned?.content ??
    (pluginContent ? absolutizeUrls(pluginContent.html, contentUrl) : null);

  // Reuse the sanitized cleaned HTML the cleanContent worker already produced,
  // but only when the content we're about to store is exactly that cleaned
  // output (not markdown/plugin content, which took a different branch above).
  // Leave the hint value `undefined` if the worker didn't return one (e.g. an
  // older bundle) so the chokepoint sanitizes normally rather than persisting a
  // spurious NULL sanitized column.
  const presanitizedCleaned: { contentCleanedSanitized?: string | null } =
    cleaned && finalContentCleaned === cleaned.content
      ? { contentCleanedSanitized: cleaned.contentSanitized }
      : {};
  const finalTitle =
    pluginContent?.title ||
    params.title ||
    markdownResult?.title ||
    metadata.title ||
    cleaned?.title ||
    null;
  const finalAuthor =
    pluginContent?.author || markdownResult?.author || metadata.author || cleaned?.byline || null;
  const finalSiteName = pluginContent?.siteName || metadata.siteName || null;

  // Compute content hash for narration deduplication
  const contentHash = generateContentHash(finalTitle, finalContentCleaned || html);

  // Handle refetch: update the existing entry if quality is acceptable
  if (existingEntry) {
    const { entry: oldEntry, userState } = existingEntry;
    const now = new Date();

    // Compare content quality to avoid overwriting good content with bad
    // (e.g., private Google Doc fetched with auth, refetched without)
    if (!params.force) {
      const oldTextLength = oldEntry.contentCleaned
        ? extractTextFromHtml(oldEntry.contentCleaned).length
        : 0;

      const newTextLength = pluginContent
        ? extractTextFromHtml(pluginContent.html).length
        : cleaned
          ? cleaned.textContent.length
          : extractTextFromHtml(html).length;

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

    // Update the existing entry with new content (sanitized at write time,
    // offloaded to a worker for large bodies since this is the request path;
    // reusing the worker-sanitized cleaned HTML when applicable).
    const update = await withSanitizedEntryContentAsync(
      {
        title: finalTitle,
        author: finalAuthor,
        contentOriginal: html,
        contentCleaned: finalContentCleaned,
        summary: excerpt,
        siteName: finalSiteName,
        imageUrl: metadata.imageUrl,
        contentHash,
        updatedAt: now,
      },
      presanitizedCleaned
    );
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
      publishMarkReadStateChanges(userId, readChanged, readCounts);
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
      imageUrl: metadata.imageUrl,
      // Serve the sanitized body computed for the write above
      contentCleaned: update.contentCleanedSanitized ?? null,
      excerpt,
      read: false, // Marked unread since content was updated
      starred: userState.starred,
      savedAt: oldEntry.fetchedAt, // Keep original save time
      outcome: "updated",
    };
  }

  const saved = await insertSavedEntry(
    db,
    userId,
    savedFeedId,
    {
      guid: normalizedUrl,
      url: normalizedUrl,
      title: finalTitle,
      author: finalAuthor,
      contentOriginal: html,
      contentCleaned: finalContentCleaned,
      summary: excerpt,
      siteName: finalSiteName,
      imageUrl: metadata.imageUrl,
      contentHash,
    },
    presanitizedCleaned
  );

  // A concurrent save (e.g. a double-click) already inserted this (feed_id,
  // guid) between our existence check above and the insert. Return the existing
  // article idempotently instead of surfacing a unique-violation 500 (#952).
  if (!saved) {
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
      // Should not happen: the insert only aborts on an existing row.
      throw new Error(`Saved article vanished after conflict: ${normalizedUrl}`);
    }
    const { entry, userState } = row;
    // See the no-refetch path above: version-check + worker-offload + self-heal
    // rather than a synchronous re-sanitize of a possibly-stale body.
    const { cleaned } = await resolveSanitizedFamily(db, entry.id, "content", {
      originalSanitized: entry.contentOriginalSanitized,
      cleanedSanitized: entry.contentCleanedSanitized,
      version: entry.contentSanitizedVersion,
      hasRaw: entry.contentOriginal !== null || entry.contentCleaned !== null,
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

  logger.info("Saved article", {
    entryId: saved.id,
    url: normalizedUrl,
    title: finalTitle,
  });

  return { ...saved, outcome: "created" };
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

  // Delete the entry (will cascade to user_entries)
  await db.delete(entries).where(eq(entries.id, articleId));

  return true;
}

/**
 * Create a saved article from pre-processed HTML content.
 *
 * This is the core function for creating uploaded articles. It accepts
 * already-processed HTML content and handles the database insertion.
 * Used by both the MCP uploadArticle and tRPC uploadFile endpoints.
 */
export async function createUploadedArticle(
  db: typeof dbType,
  userId: string,
  params: CreateUploadedArticleParams
): Promise<SavedArticle> {
  // Check content size
  const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
  if (params.contentHtml.length > maxSize) {
    throw errors.contentTooLarge("Uploaded article", maxSize);
  }

  // Get or create the user's saved feed
  const savedFeedId = await getOrCreateSavedFeed(db, userId);

  // Generate excerpt if not provided
  const excerpt = params.excerpt ?? generateSummary(params.contentHtml) ?? null;

  // Generate a unique guid for uploaded articles (no URL)
  // Format: uploaded:{uuid} to distinguish from URL-based saved articles
  const guid = `uploaded:${generateUuidv7()}`;

  // Compute content hash for narration deduplication
  const contentHash = generateContentHash(params.title, params.contentHtml);

  // Original and cleaned are the same string here, so sanitize once (off the
  // event loop for large uploads) and reuse it for both columns.
  const contentSanitized = await sanitizeEntryHtmlInWorker(params.contentHtml);
  const saved = await insertSavedEntry(
    db,
    userId,
    savedFeedId,
    {
      guid,
      url: null,
      title: params.title,
      author: params.author ?? null,
      contentOriginal: params.contentHtml,
      contentCleaned: params.contentHtml,
      summary: excerpt,
      siteName: params.siteName,
      imageUrl: null,
      contentHash,
    },
    { contentOriginalSanitized: contentSanitized, contentCleanedSanitized: contentSanitized }
  );

  // The guid is a fresh random `uploaded:{uuid}`, so the insert can't conflict.
  if (!saved) {
    throw new Error("Uploaded article insert unexpectedly conflicted");
  }

  logger.info("Created uploaded article", {
    entryId: saved.id,
    title: params.title,
    siteName: params.siteName,
  });

  return saved;
}

/**
 * Upload an article with Markdown content.
 *
 * Creates a saved article from Markdown content without requiring a URL.
 * Useful for AI assistants uploading content directly.
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

  // Convert markdown to HTML and extract title/summary/author from frontmatter or content
  const {
    html: contentCleaned,
    title: extractedTitle,
    summary,
    author,
  } = await processMarkdown(params.content);

  // Use provided title, falling back to extracted title
  const finalTitle = params.title || extractedTitle;

  return createUploadedArticle(db, userId, {
    contentHtml: contentCleaned,
    title: finalTitle,
    excerpt: summary,
    siteName: "Uploaded Article",
    author,
  });
}
