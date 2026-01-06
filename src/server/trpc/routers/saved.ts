/**
 * Saved Articles Router
 *
 * Handles saved articles (read-it-later) CRUD operations.
 * Users can save URLs to read later, similar to Pocket or Instapaper.
 *
 * Saved articles are stored as entries in a special per-user feed with type='saved'.
 *
 * Most operations on saved articles use the unified entries.* endpoints:
 * - entries.list({ type: 'saved' }) for listing
 * - entries.get for fetching single articles
 * - entries.count({ type: 'saved' }) for counts
 * - entries.markRead, entries.star, entries.unstar for mutations
 *
 * This router only handles:
 * - saved.save: Save a URL (special content extraction logic)
 * - saved.delete: Hard delete a saved article (entries use soft delete)
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { JSDOM } from "jsdom";
import { createHash } from "crypto";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { entries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { cleanContent } from "@/server/feed/content-cleaner";
import { getOrCreateSavedFeed } from "@/server/feed/saved-feed";
import {
  isLessWrongUrl,
  fetchLessWrongContentFromUrl,
  type LessWrongContent,
} from "@/server/feed/lesswrong";
import { logger } from "@/lib/logger";
import { publishSavedArticleCreated } from "@/server/redis/pubsub";

// ============================================================================
// Constants
// ============================================================================

/**
 * Timeout for fetching URLs in milliseconds.
 */
const FETCH_TIMEOUT_MS = 30000;

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * UUID validation schema for saved article IDs.
 */
const uuidSchema = z.string().uuid("Invalid saved article ID");

/**
 * URL validation schema.
 */
const urlSchema = z.string().url("Invalid URL");

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Full saved article output schema for single article view (includes content).
 */
const savedArticleFullSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  siteName: z.string().nullable(),
  author: z.string().nullable(),
  imageUrl: z.string().nullable(),
  contentOriginal: z.string().nullable(),
  contentCleaned: z.string().nullable(),
  excerpt: z.string().nullable(),
  read: z.boolean(),
  starred: z.boolean(),
  savedAt: z.date(),
  readAt: z.date().nullable(),
  starredAt: z.date().nullable(),
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Fetches a URL and returns the HTML content.
 */
async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "LionReader/1.0 (+https://lionreader.com)",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error(`Invalid content type: ${contentType}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extracts metadata from HTML using Open Graph and meta tags.
 */
interface PageMetadata {
  title: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
}

function extractMetadata(html: string, url: string): PageMetadata {
  const dom = new JSDOM(html, { url });
  const document = dom.window.document;

  // Extract title - prefer og:title, fall back to <title>
  const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute("content");
  const titleElement = document.querySelector("title")?.textContent;
  const title = ogTitle || titleElement || null;

  // Extract site name from og:site_name
  const siteName =
    document.querySelector('meta[property="og:site_name"]')?.getAttribute("content") || null;

  // Extract author from various meta tags
  const author =
    document.querySelector('meta[name="author"]')?.getAttribute("content") ||
    document.querySelector('meta[property="article:author"]')?.getAttribute("content") ||
    null;

  // Extract image from og:image
  let imageUrl =
    document.querySelector('meta[property="og:image"]')?.getAttribute("content") || null;

  // Make image URL absolute if it's relative
  if (imageUrl && !imageUrl.startsWith("http")) {
    try {
      imageUrl = new URL(imageUrl, url).href;
    } catch {
      imageUrl = null;
    }
  }

  return { title, siteName, author, imageUrl };
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
 * Escapes HTML special characters for safe embedding in HTML.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// ============================================================================
// Router
// ============================================================================

export const savedRouter = createTRPCRouter({
  /**
   * Save a URL for later reading.
   *
   * Extracts metadata (title, og:image, site name, author),
   * runs Readability for clean content, and stores in entries table.
   *
   * If `html` is provided (e.g., from a bookmarklet capturing the rendered DOM),
   * it's used directly instead of fetching the URL. This is useful for
   * JavaScript-rendered pages where server-side fetching would miss content.
   *
   * @param url - The URL to save
   * @param html - Optional pre-fetched HTML content (from bookmarklet)
   * @param title - Optional title hint (from bookmarklet's document.title)
   * @returns The saved article
   */
  save: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/saved",
        tags: ["Saved Articles"],
        summary: "Save URL for later",
      },
    })
    .input(
      z.object({
        url: urlSchema,
        html: z.string().optional(),
        title: z.string().optional(),
      })
    )
    .output(z.object({ article: savedArticleFullSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Get or create the user's saved feed
      const savedFeedId = await getOrCreateSavedFeed(ctx.db, userId);

      // Check if URL is already saved (guid = URL for saved articles)
      const existing = await ctx.db
        .select({
          entry: entries,
          userState: userEntries,
        })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(
          and(
            eq(entries.feedId, savedFeedId),
            eq(entries.guid, input.url),
            eq(userEntries.userId, userId)
          )
        )
        .limit(1);

      if (existing.length > 0) {
        // Return existing article instead of error
        const { entry, userState } = existing[0];
        return {
          article: {
            id: entry.id,
            url: entry.url!,
            title: entry.title,
            siteName: entry.siteName,
            author: entry.author,
            imageUrl: entry.imageUrl,
            contentOriginal: entry.contentOriginal,
            contentCleaned: entry.contentCleaned,
            excerpt: entry.summary,
            read: userState.read,
            starred: userState.starred,
            savedAt: entry.fetchedAt,
            readAt: userState.readAt,
            starredAt: userState.starredAt,
          },
        };
      }

      // Use provided HTML or fetch the page
      let html: string;
      // For LessWrong URLs, we may get content directly from their GraphQL API
      let lessWrongContent: LessWrongContent | null = null;

      if (input.html) {
        html = input.html;
        logger.debug("Using provided HTML for saved article", {
          url: input.url,
          htmlLength: html.length,
        });
      } else if (isLessWrongUrl(input.url)) {
        // Try LessWrong GraphQL API first (pages don't render without JavaScript)
        logger.debug("Attempting LessWrong GraphQL fetch", { url: input.url });
        lessWrongContent = await fetchLessWrongContentFromUrl(input.url);

        if (lessWrongContent) {
          // Build a title for the HTML - for comments, include post context
          const htmlTitle =
            lessWrongContent.type === "comment"
              ? `Comment on "${lessWrongContent.postTitle ?? "LessWrong post"}"`
              : (lessWrongContent.title ?? "");

          // Wrap the content in a basic HTML structure for consistency
          html = `<!DOCTYPE html><html><head><title>${escapeHtml(htmlTitle)}</title></head><body>${lessWrongContent.html}</body></html>`;
          logger.debug("Successfully fetched LessWrong content via GraphQL", {
            url: input.url,
            type: lessWrongContent.type,
            id:
              lessWrongContent.type === "post"
                ? lessWrongContent.postId
                : lessWrongContent.commentId,
          });
        } else {
          // Fall back to normal fetch
          logger.debug("LessWrong GraphQL fetch failed, falling back to normal fetch", {
            url: input.url,
          });
          try {
            html = await fetchPage(input.url);
          } catch (error) {
            logger.warn("Failed to fetch LessWrong URL", {
              url: input.url,
              error: error instanceof Error ? error.message : String(error),
            });
            throw errors.savedArticleFetchError(
              input.url,
              error instanceof Error ? error.message : "Unknown error"
            );
          }
        }
      } else {
        try {
          html = await fetchPage(input.url);
        } catch (error) {
          logger.warn("Failed to fetch URL for saved article", {
            url: input.url,
            error: error instanceof Error ? error.message : String(error),
          });
          throw errors.savedArticleFetchError(
            input.url,
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      }

      // Extract metadata (for LessWrong, we already have better metadata from GraphQL)
      const metadata = extractMetadata(html, input.url);

      // Run Readability for clean content (also absolutizes URLs internally)
      // For LessWrong, the GraphQL content is already clean, but Readability will still
      // absolutize URLs and provide consistent output format
      const cleaned = cleanContent(html, { url: input.url });

      // Generate excerpt
      let excerpt: string | null = null;
      if (cleaned) {
        excerpt = cleaned.excerpt || cleaned.textContent.slice(0, 300).trim() || null;
        if (excerpt && excerpt.length > 300) {
          excerpt = excerpt.slice(0, 297) + "...";
        }
      }

      // Use provided title, then LessWrong API, then metadata, then Readability as fallback
      // For LessWrong comments, create a descriptive title
      let lessWrongTitle: string | null = null;
      if (lessWrongContent) {
        if (lessWrongContent.type === "comment") {
          // For comments, create a title like "Comment by Author on Post Title"
          const authorPart = lessWrongContent.author
            ? `${lessWrongContent.author}'s comment`
            : "Comment";
          const postPart = lessWrongContent.postTitle ? ` on "${lessWrongContent.postTitle}"` : "";
          lessWrongTitle = `${authorPart}${postPart}`;
        } else {
          lessWrongTitle = lessWrongContent.title;
        }
      }
      const finalTitle = input.title || lessWrongTitle || metadata.title || cleaned?.title || null;
      // For author, prefer LessWrong API data (has proper author info), then metadata
      const finalAuthor = lessWrongContent?.author || metadata.author || cleaned?.byline || null;
      // For siteName, use LessWrong when content came from their API
      const finalSiteName = lessWrongContent ? "LessWrong" : metadata.siteName;
      // For publishedAt, prefer LessWrong API's postedAt when available
      const finalPublishedAt = lessWrongContent?.publishedAt ?? now;

      // Compute content hash for narration deduplication
      const contentHash = generateContentHash(finalTitle, cleaned?.content || html);

      // Create the saved article entry
      const entryId = generateUuidv7();
      await ctx.db.insert(entries).values({
        id: entryId,
        feedId: savedFeedId,
        type: "saved",
        guid: input.url, // For saved articles, guid = URL
        url: input.url,
        title: finalTitle,
        author: finalAuthor,
        contentOriginal: html,
        contentCleaned: cleaned?.content || null,
        summary: excerpt,
        siteName: finalSiteName,
        imageUrl: metadata.imageUrl,
        publishedAt: finalPublishedAt,
        fetchedAt: now, // When saved
        contentHash,
        // Email-specific fields are NULL for saved entries
        spamScore: null,
        isSpam: false,
        listUnsubscribeMailto: null,
        listUnsubscribeHttps: null,
        listUnsubscribePost: null,
        createdAt: now,
        updatedAt: now,
      });

      // Create user_entries row
      await ctx.db.insert(userEntries).values({
        userId,
        entryId,
        read: false,
        starred: false,
        readAt: null,
        starredAt: null,
      });

      // Publish event to notify other browser windows/tabs
      await publishSavedArticleCreated(userId, entryId);

      return {
        article: {
          id: entryId,
          url: input.url,
          title: finalTitle,
          siteName: finalSiteName,
          author: finalAuthor,
          imageUrl: metadata.imageUrl,
          contentOriginal: html,
          contentCleaned: cleaned?.content || null,
          excerpt,
          read: false,
          starred: false,
          savedAt: finalPublishedAt,
          readAt: null,
          starredAt: null,
        },
      };
    }),

  /**
   * Delete a saved article (hard delete).
   *
   * Saved articles are per-user, so hard delete is safe.
   * Deleting the entry will cascade to user_entries.
   *
   * @param id - The saved article ID to delete
   * @returns Empty object on success
   */
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/saved/{id}",
        tags: ["Saved Articles"],
        summary: "Delete saved article",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({}))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Get or create the user's saved feed
      const savedFeedId = await getOrCreateSavedFeed(ctx.db, userId);

      // Verify the article exists and belongs to the user's saved feed
      const existing = await ctx.db
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(
          and(
            eq(entries.id, input.id),
            eq(entries.feedId, savedFeedId),
            eq(userEntries.userId, userId)
          )
        )
        .limit(1);

      if (existing.length === 0) {
        throw errors.savedArticleNotFound();
      }

      // Delete the entry (will cascade to user_entries)
      await ctx.db.delete(entries).where(eq(entries.id, input.id));

      return {};
    }),
});
