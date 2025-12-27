/**
 * Saved Articles Router
 *
 * Handles saved articles (read-it-later) CRUD operations.
 * Users can save URLs to read later, similar to Pocket or Instapaper.
 */

import { z } from "zod";
import { eq, and, desc, lt, inArray } from "drizzle-orm";
import { JSDOM } from "jsdom";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { savedArticles } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { cleanContent } from "@/server/feed/content-cleaner";
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

// ============================================================================
// Router
// ============================================================================

export const savedRouter = createTRPCRouter({
  /**
   * Save a URL for later reading.
   *
   * Fetches the page, extracts metadata (title, og:image, site name, author),
   * runs Readability for clean content, and stores in saved_articles.
   *
   * @param url - The URL to save
   * @returns The saved article
   */
  save: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/saved",
        tags: ["Saved Articles"],
        summary: "Save URL for later",
      },
    })
    .input(
      z.object({
        url: urlSchema,
      })
    )
    .output(z.object({ article: savedArticleFullSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Check if URL is already saved
      const existing = await ctx.db
        .select()
        .from(savedArticles)
        .where(and(eq(savedArticles.userId, userId), eq(savedArticles.url, input.url)))
        .limit(1);

      if (existing.length > 0) {
        // Return existing article instead of error
        const article = existing[0];
        return {
          article: {
            id: article.id,
            url: article.url,
            title: article.title,
            siteName: article.siteName,
            author: article.author,
            imageUrl: article.imageUrl,
            contentOriginal: article.contentOriginal,
            contentCleaned: article.contentCleaned,
            excerpt: article.excerpt,
            read: article.read,
            starred: article.starred,
            savedAt: article.savedAt,
            readAt: article.readAt,
            starredAt: article.starredAt,
          },
        };
      }

      // Fetch the page
      let html: string;
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

      // Use Readability's title/byline as fallback
      const finalTitle = metadata.title || cleaned?.title || null;
      const finalAuthor = metadata.author || cleaned?.byline || null;

      // Create the saved article
      const articleId = generateUuidv7();
      await ctx.db.insert(savedArticles).values({
        id: articleId,
        userId,
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
        createdAt: now,
        updatedAt: now,
      });

      return {
        article: {
          id: articleId,
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
   * @param unreadOnly - Optional filter to show only unread articles
   * @param starredOnly - Optional filter to show only starred articles
   * @param cursor - Optional pagination cursor (from previous response)
   * @param limit - Optional number of articles per page (default: 50, max: 100)
   * @returns Paginated list of saved articles
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/saved",
        tags: ["Saved Articles"],
        summary: "List saved articles",
      },
    })
    .input(
      z.object({
        unreadOnly: z.boolean().optional(),
        starredOnly: z.boolean().optional(),
        cursor: cursorSchema,
        limit: limitSchema,
      })
    )
    .output(savedArticlesListOutputSchema)
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input.limit ?? DEFAULT_LIMIT;

      // Build query conditions
      const conditions = [eq(savedArticles.userId, userId)];

      // Add cursor condition if present
      if (input.cursor) {
        const cursorArticleId = decodeCursor(input.cursor);
        conditions.push(lt(savedArticles.id, cursorArticleId));
      }

      // Query saved articles
      // We fetch one extra to determine if there are more results
      let results = await ctx.db
        .select()
        .from(savedArticles)
        .where(and(...conditions))
        .orderBy(desc(savedArticles.id))
        .limit(limit + 1);

      // Apply unreadOnly filter
      if (input.unreadOnly) {
        results = results.filter((article) => !article.read);
      }

      // Apply starredOnly filter
      if (input.starredOnly) {
        results = results.filter((article) => article.starred);
      }

      // Determine if there are more results
      const hasMore = results.length > limit;
      const resultArticles = hasMore ? results.slice(0, limit) : results;

      // Format the output
      const items = resultArticles.map((article) => ({
        id: article.id,
        url: article.url,
        title: article.title,
        siteName: article.siteName,
        author: article.author,
        imageUrl: article.imageUrl,
        excerpt: article.excerpt,
        read: article.read,
        starred: article.starred,
        savedAt: article.savedAt,
      }));

      // Generate next cursor if there are more results
      const nextCursor =
        hasMore && resultArticles.length > 0
          ? encodeCursor(resultArticles[resultArticles.length - 1].id)
          : undefined;

      return { items, nextCursor };
    }),

  /**
   * Get a single saved article by ID with full content.
   *
   * @param id - The saved article ID
   * @returns The full saved article with content
   */
  get: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/v1/saved/{id}",
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

      // Get the saved article
      const result = await ctx.db
        .select()
        .from(savedArticles)
        .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)))
        .limit(1);

      if (result.length === 0) {
        throw errors.savedArticleNotFound();
      }

      const article = result[0];

      return {
        article: {
          id: article.id,
          url: article.url,
          title: article.title,
          siteName: article.siteName,
          author: article.author,
          imageUrl: article.imageUrl,
          contentOriginal: article.contentOriginal,
          contentCleaned: article.contentCleaned,
          excerpt: article.excerpt,
          read: article.read,
          starred: article.starred,
          savedAt: article.savedAt,
          readAt: article.readAt,
          starredAt: article.starredAt,
        },
      };
    }),

  /**
   * Delete a saved article (hard delete).
   *
   * @param id - The saved article ID to delete
   * @returns Empty object on success
   */
  delete: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/v1/saved/{id}",
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

      // Verify the article exists and belongs to the user
      const existing = await ctx.db
        .select({ id: savedArticles.id })
        .from(savedArticles)
        .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)))
        .limit(1);

      if (existing.length === 0) {
        throw errors.savedArticleNotFound();
      }

      // Delete the article
      await ctx.db
        .delete(savedArticles)
        .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)));

      return {};
    }),

  /**
   * Mark saved articles as read or unread (bulk operation).
   *
   * @param ids - Array of saved article IDs to mark
   * @param read - Whether to mark as read (true) or unread (false)
   * @returns Empty object on success
   */
  markRead: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/saved/mark-read",
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
    .output(z.object({}))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const now = new Date();

      // Get articles that belong to the user
      const existingArticles = await ctx.db
        .select({ id: savedArticles.id })
        .from(savedArticles)
        .where(and(inArray(savedArticles.id, input.ids), eq(savedArticles.userId, userId)));

      if (existingArticles.length === 0) {
        return {};
      }

      const validIds = existingArticles.map((a) => a.id);

      // Update all matching articles
      await ctx.db
        .update(savedArticles)
        .set({
          read: input.read,
          readAt: input.read ? now : null,
          updatedAt: now,
        })
        .where(and(inArray(savedArticles.id, validIds), eq(savedArticles.userId, userId)));

      return {};
    }),

  /**
   * Star a saved article.
   *
   * @param id - The saved article ID to star
   * @returns Empty object on success
   */
  star: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/v1/saved/{id}/star",
        tags: ["Saved Articles"],
        summary: "Star saved article",
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
      const now = new Date();

      // Verify the article exists and belongs to the user
      const existing = await ctx.db
        .select({ id: savedArticles.id })
        .from(savedArticles)
        .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)))
        .limit(1);

      if (existing.length === 0) {
        throw errors.savedArticleNotFound();
      }

      // Update the article
      await ctx.db
        .update(savedArticles)
        .set({
          starred: true,
          starredAt: now,
          updatedAt: now,
        })
        .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)));

      return {};
    }),

  /**
   * Unstar a saved article.
   *
   * @param id - The saved article ID to unstar
   * @returns Empty object on success
   */
  unstar: protectedProcedure
    .meta({
      openapi: {
        method: "DELETE",
        path: "/v1/saved/{id}/star",
        tags: ["Saved Articles"],
        summary: "Unstar saved article",
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
      const now = new Date();

      // Verify the article exists and belongs to the user
      const existing = await ctx.db
        .select({ id: savedArticles.id })
        .from(savedArticles)
        .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)))
        .limit(1);

      if (existing.length === 0) {
        throw errors.savedArticleNotFound();
      }

      // Update the article
      await ctx.db
        .update(savedArticles)
        .set({
          starred: false,
          starredAt: null,
          updatedAt: now,
        })
        .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)));

      return {};
    }),
});
