/**
 * Saved Articles Service
 *
 * Business logic for saving articles. Used by both tRPC routers and MCP server.
 * Uses the plugin system for special URL handling (LessWrong, ArXiv, Google Docs, etc.).
 */

import { eq, and } from "drizzle-orm";
import { Parser } from "htmlparser2";
import { createHash } from "crypto";
import type { db as dbType } from "@/server/db";
import { entries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { normalizeUrl } from "@/lib/url";
import { fetchHtmlPage, HttpFetchError, ContentTooLargeError } from "@/server/http/fetch";
import { processMarkdown } from "@/server/markdown";
import { usageLimitsConfig } from "@/server/config/env";
import { wrapHtmlFragment } from "@/server/http/html";
import { cleanContent } from "@/server/feed/content-cleaner";
import { getOrCreateSavedFeed } from "@/server/feed/saved-feed";
import { generateSummary } from "@/server/html/strip-html";
import { logger } from "@/lib/logger";
import { publishNewEntry } from "@/server/redis/pubsub";
import { errors } from "@/server/trpc/errors";
import { pluginRegistry } from "@/server/plugins";

// ============================================================================
// Types
// ============================================================================

export interface SaveArticleParams {
  url: string;
  /** Optional title hint (useful when page title is poor) */
  title?: string;
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
export function generateContentHash(title: string | null, content: string | null): string {
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
  contentCleaned: string;
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
 */
async function insertSavedEntry(
  db: typeof dbType,
  userId: string,
  savedFeedId: string,
  params: InsertSavedEntryParams
): Promise<SavedArticle> {
  const now = new Date();
  const entryId = generateUuidv7();

  await db.insert(entries).values({
    id: entryId,
    feedId: savedFeedId,
    type: "saved",
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
  });

  await db.insert(userEntries).values({
    userId,
    entryId,
    read: false,
    starred: false,
  });

  await publishNewEntry(savedFeedId, entryId, now, "saved");

  return {
    id: entryId,
    url: params.url,
    title: params.title,
    siteName: params.siteName,
    author: params.author,
    imageUrl: params.imageUrl,
    contentCleaned: params.contentCleaned,
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
 * Save a URL for later reading.
 *
 * Fetches the URL, extracts metadata and clean content via Readability,
 * and stores it as a saved article. If the URL is already saved, returns
 * the existing article.
 *
 * Uses the plugin system for special URL handling (LessWrong, ArXiv, Google Docs, etc.).
 */
export async function saveArticle(
  db: typeof dbType,
  userId: string,
  params: SaveArticleParams
): Promise<SavedArticle> {
  const normalizedUrl = normalizeUrl(params.url);

  // Get or create the user's saved feed
  const savedFeedId = await getOrCreateSavedFeed(db, userId);

  // Check if URL is already saved
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

  if (existing.length > 0) {
    const { entry, userState } = existing[0];
    return {
      id: entry.id,
      url: entry.url!,
      title: entry.title,
      siteName: entry.siteName,
      author: entry.author,
      imageUrl: entry.imageUrl,
      contentCleaned: entry.contentCleaned,
      excerpt: entry.summary,
      read: userState.read,
      starred: userState.starred,
      savedAt: entry.fetchedAt,
    };
  }

  // Try to find a plugin for this URL
  let urlObj: URL | null = null;
  try {
    urlObj = new URL(params.url);
  } catch {
    // Invalid URL, continue to normal fetch
  }

  const plugin = urlObj ? pluginRegistry.findWithCapability(urlObj, "savedArticle") : null;

  let html: string;
  // The URL the content was actually fetched from (after redirects).
  // Used for resolving relative URLs in the content.
  let contentUrl: string = params.url;
  let pluginContent: {
    html: string;
    title?: string | null;
    author?: string | null;
    siteName?: string;
    skipReadability?: boolean;
  } | null = null;

  if (plugin) {
    logger.debug("Attempting plugin fetch for saved article", {
      url: params.url,
      plugin: plugin.name,
    });

    try {
      const content = await plugin.capabilities.savedArticle.fetchContent(urlObj!);
      if (content) {
        // Check plugin content size
        const maxSize = usageLimitsConfig.maxSavedArticleSizeBytes;
        if (content.html.length > maxSize) {
          throw errors.contentTooLarge("Article", maxSize);
        }

        pluginContent = {
          html: content.html,
          title: content.title,
          author: content.author,
          siteName: plugin.capabilities.savedArticle.siteName,
          skipReadability: plugin.capabilities.savedArticle.skipReadability,
        };
        html = content.html;
        if (content.canonicalUrl) {
          contentUrl = content.canonicalUrl;
        }
        logger.debug("Successfully fetched content via plugin", {
          url: params.url,
          plugin: plugin.name,
          title: content.title,
        });
      }
    } catch (error) {
      logger.warn("Plugin fetch failed, falling back to normal fetch", {
        url: params.url,
        plugin: plugin.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Track Markdown processing results (skip Readability for Markdown)
  let markdownResult: {
    html: string;
    title: string | null;
    summary: string | null;
    author: string | null;
  } | null = null;

  // Fall back to normal HTML fetch if no plugin or plugin failed
  if (!pluginContent) {
    try {
      const result = await fetchHtmlPage(params.url);
      contentUrl = result.finalUrl;

      // If we got Markdown, convert it to HTML and extract title
      if (result.isMarkdown) {
        logger.debug("Converting Markdown to HTML for saved article (will skip Readability)", {
          url: params.url,
        });
        markdownResult = await processMarkdown(result.content);
        html = wrapHtmlFragment(markdownResult.html, markdownResult.title);
      } else {
        html = result.content;
      }
    } catch (error) {
      logger.warn("Failed to fetch URL for saved article", {
        url: params.url,
        error: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof ContentTooLargeError) {
        throw errors.contentTooLarge("Article", usageLimitsConfig.maxSavedArticleSizeBytes);
      }
      if (error instanceof HttpFetchError && error.isBlocked()) {
        throw errors.siteBlocked(params.url, error.status);
      }
      throw errors.savedArticleFetchError(
        params.url,
        error instanceof Error ? error.message : "Unknown error"
      );
    }
  }

  // Extract metadata
  const metadata = extractMetadata(html!, contentUrl);

  // Run Readability for clean content (skip for plugins that request it, or for Markdown)
  const shouldSkipReadability = pluginContent?.skipReadability || markdownResult !== null;
  const cleaned = shouldSkipReadability ? null : cleanContent(html!, { url: contentUrl });

  // Generate excerpt - prefer frontmatter summary for Markdown content
  let excerpt: string | null = null;
  if (markdownResult?.summary) {
    // Use summary from frontmatter
    excerpt = markdownResult.summary;
  } else if (shouldSkipReadability) {
    // For content that skips Readability (plugins or Markdown), extract summary from HTML
    excerpt = generateSummary(html!) || null;
  } else if (cleaned) {
    excerpt = cleaned.excerpt || cleaned.textContent.slice(0, 300).trim() || null;
    if (excerpt && excerpt.length > 300) {
      excerpt = excerpt.slice(0, 297) + "...";
    }
  }

  // Build final values - prefer plugin data, then provided hint, then extracted/metadata, then Readability
  const finalContentCleaned = markdownResult?.html || cleaned?.content || html!;
  const finalTitle =
    pluginContent?.title ||
    params.title ||
    markdownResult?.title ||
    metadata.title ||
    cleaned?.title ||
    null;
  const finalAuthor =
    pluginContent?.author || markdownResult?.author || metadata.author || cleaned?.byline || null;
  const finalSiteName = pluginContent?.siteName || metadata.siteName;

  // Compute content hash for narration deduplication
  const contentHash = generateContentHash(finalTitle, finalContentCleaned || html!);

  const saved = await insertSavedEntry(db, userId, savedFeedId, {
    guid: normalizedUrl,
    url: normalizedUrl,
    title: finalTitle,
    author: finalAuthor,
    contentOriginal: html!,
    contentCleaned: finalContentCleaned,
    summary: excerpt,
    siteName: finalSiteName ?? null,
    imageUrl: metadata.imageUrl,
    contentHash,
  });

  logger.info("Saved article via service", {
    entryId: saved.id,
    url: normalizedUrl,
    title: finalTitle,
    plugin: plugin?.name,
  });

  return saved;
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
  const savedFeedId = await getOrCreateSavedFeed(db, userId);

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

  const saved = await insertSavedEntry(db, userId, savedFeedId, {
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
  });

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
