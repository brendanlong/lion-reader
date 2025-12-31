/**
 * Saved Articles Router
 *
 * Handles saved articles (read-it-later) CRUD operations.
 * Users can save URLs to read later, similar to Pocket or Instapaper.
 *
 * Saved articles are stored as entries in a special per-user feed with type='saved'.
 */

import { z } from "zod";
import { eq, and, desc, asc, lt, gt, inArray, sql } from "drizzle-orm";
import { JSDOM } from "jsdom";
import { createHash } from "crypto";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { entries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { cleanContent } from "@/server/feed/content-cleaner";
import { getOrCreateSavedFeed } from "@/server/feed/saved-feed";
import { logger } from "@/lib/logger";

// ============================================================================
// Constants
// ============================================================================

/**
 * Default number of saved articles to return per page.
 */
const DEFAULT_LIMIT = 50;

/**
 * Maximum number of saved articles that can be requested per page.
 */
const MAX_LIMIT = 100;

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
 * Cursor validation schema (base64-encoded article ID).
 */
const cursorSchema = z.string().optional();

/**
 * Limit validation schema.
 */
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).optional();

/**
 * URL validation schema.
 */
const urlSchema = z.string().url("Invalid URL");

/**
 * Boolean query parameter schema that handles string coercion.
 * Query parameters come as strings from HTTP requests, so we need to
 * handle both boolean and string inputs ("true"/"false").
 */
const booleanQueryParam = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .optional()
  .transform((val) => {
    if (val === "true") return true;
    if (val === "false") return false;
    return val;
  });

/**
 * Sort order validation schema.
 */
const sortOrderSchema = z.enum(["newest", "oldest"]).optional();

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Lightweight saved article output schema for list view (no full content).
 */
const savedArticleListItemSchema = z.object({
  id: z.string(),
  url: z.string(),
  title: z.string().nullable(),
  siteName: z.string().nullable(),
  author: z.string().nullable(),
  imageUrl: z.string().nullable(),
  excerpt: z.string().nullable(),
  read: z.boolean(),
  starred: z.boolean(),
  savedAt: z.date(),
});

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

/**
 * Paginated saved articles list output schema.
 */
const savedArticlesListOutputSchema = z.object({
  items: z.array(savedArticleListItemSchema),
  nextCursor: z.string().optional(),
});

/**
 * Schema for articles returned from mutation operations.
 * Used by normy for automatic cache normalization.
 */
const savedArticleMutationResultSchema = z.object({
  id: z.string(),
  read: z.boolean(),
  starred: z.boolean(),
});

/**
 * Output schema for markRead mutation.
 */
const markReadOutputSchema = z.object({
  articles: z.array(savedArticleMutationResultSchema),
});

/**
 * Output schema for star/unstar mutations.
 * Returns single article for normy cache normalization.
 */
const starOutputSchema = z.object({
  article: savedArticleMutationResultSchema,
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Decodes a cursor to get the article ID.
 * Cursor is base64-encoded article ID.
 *
 * @param cursor - The cursor string
 * @returns The decoded article ID
 */
function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, "base64").toString("utf8");
  } catch {
    throw errors.validation("Invalid cursor format");
  }
}

/**
 * Encodes an article ID as a cursor.
 *
 * @param articleId - The article ID
 * @returns The encoded cursor
 */
function encodeCursor(articleId: string): string {
  return Buffer.from(articleId, "utf8").toString("base64");
}

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
      if (input.html) {
        html = input.html;
        logger.debug("Using provided HTML for saved article", {
          url: input.url,
          htmlLength: html.length,
        });
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

      // Extract metadata
      const metadata = extractMetadata(html, input.url);

      // Run Readability for clean content
      const cleaned = cleanContent(html, { url: input.url });

      // Generate excerpt
      let excerpt: string | null = null;
      if (cleaned) {
        excerpt = cleaned.excerpt || cleaned.textContent.slice(0, 300).trim() || null;
        if (excerpt && excerpt.length > 300) {
          excerpt = excerpt.slice(0, 297) + "...";
        }
      }

      // Use provided title, then metadata, then Readability as fallback
      const finalTitle = input.title || metadata.title || cleaned?.title || null;
      const finalAuthor = metadata.author || cleaned?.byline || null;

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
        siteName: metadata.siteName,
        imageUrl: metadata.imageUrl,
        publishedAt: now, // When saved
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

      return {
        article: {
          id: entryId,
          url: input.url,
          title: finalTitle,
          siteName: metadata.siteName,
          author: finalAuthor,
          imageUrl: metadata.imageUrl,
          contentOriginal: html,
          contentCleaned: cleaned?.content || null,
          excerpt,
          read: false,
          starred: false,
          savedAt: now,
          readAt: null,
          starredAt: null,
        },
      };
    }),

  /**
   * List saved articles with filters and cursor-based pagination.
   *
   * @deprecated Use entries.list({ type: 'saved' }) instead - provides unified access to all entry types.
   *
   * @param unreadOnly - Optional filter to show only unread articles
   * @param starredOnly - Optional filter to show only starred articles
   * @param sortOrder - Optional sort order: "newest" (default) or "oldest"
   * @param cursor - Optional pagination cursor (from previous response)
   * @param limit - Optional number of articles per page (default: 50, max: 100)
   * @returns Paginated list of saved articles
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/saved",
        tags: ["Saved Articles"],
        summary: "List saved articles",
      },
    })
    .input(
      z.object({
        unreadOnly: booleanQueryParam,
        starredOnly: booleanQueryParam,
        sortOrder: sortOrderSchema,
        cursor: cursorSchema,
        limit: limitSchema,
      })
    )
    .output(savedArticlesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input.limit ?? DEFAULT_LIMIT;
      const sortOrder = input.sortOrder ?? "newest";

      // Get or create the user's saved feed
      const savedFeedId = await getOrCreateSavedFeed(ctx.db, userId);

      // Build query conditions
      const conditions = [eq(entries.feedId, savedFeedId), eq(userEntries.userId, userId)];

      // Apply unreadOnly filter
      if (input.unreadOnly) {
        conditions.push(eq(userEntries.read, false));
      }

      // Apply starredOnly filter
      if (input.starredOnly) {
        conditions.push(eq(userEntries.starred, true));
      }

      // Add cursor condition if present
      // For newest-first (desc), we want entries with ID < cursor
      // For oldest-first (asc), we want entries with ID > cursor
      if (input.cursor) {
        const cursorEntryId = decodeCursor(input.cursor);
        if (sortOrder === "newest") {
          conditions.push(lt(entries.id, cursorEntryId));
        } else {
          conditions.push(gt(entries.id, cursorEntryId));
        }
      }

      // Query saved articles with appropriate sort order
      // We fetch one extra to determine if there are more results
      const orderByClause = sortOrder === "newest" ? desc(entries.id) : asc(entries.id);
      const results = await ctx.db
        .select({
          entry: entries,
          userState: userEntries,
        })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(and(...conditions))
        .orderBy(orderByClause)
        .limit(limit + 1);

      // Determine if there are more results
      const hasMore = results.length > limit;
      const resultEntries = hasMore ? results.slice(0, limit) : results;

      // Format the output
      const items = resultEntries.map(({ entry, userState }) => ({
        id: entry.id,
        url: entry.url!,
        title: entry.title,
        siteName: entry.siteName,
        author: entry.author,
        imageUrl: entry.imageUrl,
        excerpt: entry.summary,
        read: userState.read,
        starred: userState.starred,
        savedAt: entry.fetchedAt,
      }));

      // Generate next cursor if there are more results
      const nextCursor =
        hasMore && resultEntries.length > 0
          ? encodeCursor(resultEntries[resultEntries.length - 1].entry.id)
          : undefined;

      return { items, nextCursor };
    }),

  /**
   * Get a single saved article by ID with full content.
   *
   * @deprecated Use entries.get instead - provides unified access to all entry types.
   *
   * @param id - The saved article ID
   * @returns The full saved article with content
   */
  get: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/saved/{id}",
        tags: ["Saved Articles"],
        summary: "Get saved article",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(z.object({ article: savedArticleFullSchema }))
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Get or create the user's saved feed to ensure it exists
      const savedFeedId = await getOrCreateSavedFeed(ctx.db, userId);

      // Get the saved article
      const result = await ctx.db
        .select({
          entry: entries,
          userState: userEntries,
        })
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

      if (result.length === 0) {
        throw errors.savedArticleNotFound();
      }

      const { entry, userState } = result[0];

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

  /**
   * Mark saved articles as read or unread (bulk operation).
   *
   * @deprecated Use entries.markRead instead - works with all entry types including saved articles.
   *
   * @param ids - Array of saved article IDs to mark
   * @param read - Whether to mark as read (true) or unread (false)
   * @returns The updated articles with their current state
   */
  markRead: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/saved/mark-read",
        tags: ["Saved Articles"],
        summary: "Mark saved articles read/unread",
      },
    })
    .input(
      z.object({
        ids: z
          .array(uuidSchema)
          .min(1, "At least one article ID is required")
          .max(1000, "Maximum 1000 articles per request"),
        read: z.boolean(),
      })
    )
    .output(markReadOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Get or create the user's saved feed
      const savedFeedId = await getOrCreateSavedFeed(ctx.db, userId);

      // Get entries that belong to the user's saved feed
      const existingEntries = await ctx.db
        .select({ id: entries.id })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(
          and(
            inArray(entries.id, input.ids),
            eq(entries.feedId, savedFeedId),
            eq(userEntries.userId, userId)
          )
        );

      if (existingEntries.length === 0) {
        return { articles: [] };
      }

      const validIds = existingEntries.map((e) => e.id);

      // Update all matching user_entries
      await ctx.db
        .update(userEntries)
        .set({
          read: input.read,
          readAt: input.read ? now : null,
        })
        .where(and(inArray(userEntries.entryId, validIds), eq(userEntries.userId, userId)));

      // Fetch the updated articles to return their current state
      // This enables normy to automatically update cached queries
      const updatedArticles = await ctx.db
        .select({
          id: userEntries.entryId,
          read: userEntries.read,
          starred: userEntries.starred,
        })
        .from(userEntries)
        .where(and(inArray(userEntries.entryId, validIds), eq(userEntries.userId, userId)));

      return { articles: updatedArticles };
    }),

  /**
   * Star a saved article.
   *
   * @deprecated Use entries.star instead - works with all entry types including saved articles.
   *
   * @param id - The saved article ID to star
   * @returns The updated article with current state
   */
  star: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/saved/{id}/star",
        tags: ["Saved Articles"],
        summary: "Star saved article",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(starOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

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

      // Update the user_entries
      await ctx.db
        .update(userEntries)
        .set({
          starred: true,
          starredAt: now,
        })
        .where(and(eq(userEntries.entryId, input.id), eq(userEntries.userId, userId)));

      // Fetch the updated article to return its current state
      // This enables normy to automatically update cached queries
      const updatedArticle = await ctx.db
        .select({
          id: userEntries.entryId,
          read: userEntries.read,
          starred: userEntries.starred,
        })
        .from(userEntries)
        .where(and(eq(userEntries.entryId, input.id), eq(userEntries.userId, userId)))
        .limit(1);

      return { article: updatedArticle[0] };
    }),

  /**
   * Unstar a saved article.
   *
   * @deprecated Use entries.unstar instead - works with all entry types including saved articles.
   *
   * @param id - The saved article ID to unstar
   * @returns The updated article with current state
   */
  unstar: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/saved/{id}/star",
        tags: ["Saved Articles"],
        summary: "Unstar saved article",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(starOutputSchema)
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

      // Update the user_entries
      await ctx.db
        .update(userEntries)
        .set({
          starred: false,
          starredAt: null,
        })
        .where(and(eq(userEntries.entryId, input.id), eq(userEntries.userId, userId)));

      // Fetch the updated article to return its current state
      // This enables normy to automatically update cached queries
      const updatedArticle = await ctx.db
        .select({
          id: userEntries.entryId,
          read: userEntries.read,
          starred: userEntries.starred,
        })
        .from(userEntries)
        .where(and(eq(userEntries.entryId, input.id), eq(userEntries.userId, userId)))
        .limit(1);

      return { article: updatedArticle[0] };
    }),

  /**
   * Get count of saved articles.
   *
   * @deprecated Use entries.count({ type: 'saved' }) instead - provides unified access to all entry types.
   *
   * @returns Count of total and unread saved articles
   */
  count: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/saved/count",
        tags: ["Saved Articles"],
        summary: "Get saved articles count",
      },
    })
    .input(z.object({}))
    .output(
      z.object({
        total: z.number(),
        unread: z.number(),
      })
    )
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;

      // Get or create the user's saved feed
      const savedFeedId = await getOrCreateSavedFeed(ctx.db, userId);

      // Get total count
      const totalResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(and(eq(entries.feedId, savedFeedId), eq(userEntries.userId, userId)));

      // Get unread count
      const unreadResult = await ctx.db
        .select({ count: sql<number>`count(*)::int` })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(
          and(
            eq(entries.feedId, savedFeedId),
            eq(userEntries.userId, userId),
            eq(userEntries.read, false)
          )
        );

      return {
        total: totalResult[0]?.count ?? 0,
        unread: unreadResult[0]?.count ?? 0,
      };
    }),
});
