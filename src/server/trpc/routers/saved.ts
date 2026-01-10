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
import { Parser } from "htmlparser2";
import { createHash } from "crypto";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { fetchHtmlPage } from "@/server/http/fetch";
import { escapeHtml } from "@/server/http/html";
import { entries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { normalizeUrl } from "@/lib/url";
import { cleanContent } from "@/server/feed/content-cleaner";
import { getOrCreateSavedFeed } from "@/server/feed/saved-feed";
import {
  isLessWrongUrl,
  fetchLessWrongContentFromUrl,
  type LessWrongContent,
} from "@/server/feed/lesswrong";
import { isArxivTransformableUrl, getArxivFetchUrl } from "@/server/feed/arxiv";
import {
  isGoogleDocsUrl,
  fetchGoogleDocsFromUrl,
  fetchPrivateGoogleDoc,
  extractDocId,
  extractTabId,
  normalizeGoogleDocsUrl,
  GOOGLE_DRIVE_SCOPE,
  type GoogleDocsContent,
} from "@/server/google/docs";
import { getOAuthAccount, hasGoogleScope, getValidGoogleToken } from "@/server/google/tokens";
import { GOOGLE_DOCS_READONLY_SCOPE } from "@/server/auth";
import { logger } from "@/lib/logger";
import { publishSavedArticleCreated } from "@/server/redis/pubsub";

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
});

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Extracts metadata from HTML using Open Graph and meta tags.
 * Uses SAX parsing for efficiency and exits early after </head>.
 */
interface PageMetadata {
  title: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
}

function extractMetadata(html: string, url: string): PageMetadata {
  // Use an object to collect results - avoids TypeScript control flow issues with callbacks
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
          // Exit early after </head> - metadata is only in head
          parser.pause();
        }
      },
    },
    { decodeEntities: true }
  );

  parser.write(html);
  parser.end();

  // Prefer og:title, fall back to <title>
  result.title = ogTitle || titleText;

  // Make image URL absolute if it's relative
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

      // Normalize URL: strip fragments (two URLs differing only by #section point to same article)
      // For Google Docs, also remove extraneous query params except 'tab'
      let normalizedUrl = normalizeUrl(input.url);
      if (isGoogleDocsUrl(normalizedUrl)) {
        normalizedUrl = normalizeGoogleDocsUrl(normalizedUrl);
      }

      // Get or create the user's saved feed
      const savedFeedId = await getOrCreateSavedFeed(ctx.db, userId);

      // Check if URL is already saved (guid = normalized URL for saved articles)
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
            eq(entries.guid, normalizedUrl),
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
          },
        };
      }

      // Use provided HTML or fetch the page
      let html: string | undefined;
      // For LessWrong URLs, we may get content directly from their GraphQL API
      let lessWrongContent: LessWrongContent | null = null;
      // For Google Docs URLs, we may get content from the Google Docs API
      let googleDocsContent: GoogleDocsContent | null = null;

      if (input.html) {
        html = input.html;
        logger.debug("Using provided HTML for saved article", {
          url: input.url,
          htmlLength: html.length,
        });
      } else if (isGoogleDocsUrl(input.url)) {
        // Try Google Docs API first (pages don't render well without JavaScript)
        // Use normalized URL for consistent fetching
        logger.debug("Attempting Google Docs API fetch", { url: normalizedUrl });
        googleDocsContent = await fetchGoogleDocsFromUrl(normalizedUrl);

        if (googleDocsContent) {
          // Public fetch succeeded
          html = `<!DOCTYPE html><html><head><title>${escapeHtml(googleDocsContent.title)}</title></head><body>${googleDocsContent.html}</body></html>`;
          logger.debug("Successfully fetched Google Docs content via API", {
            url: normalizedUrl,
            docId: googleDocsContent.docId,
            title: googleDocsContent.title,
          });
        } else {
          // Public fetch failed, try with user's OAuth token if available
          const docId = extractDocId(normalizedUrl);
          const tabId = extractTabId(normalizedUrl);

          if (docId) {
            // Check if user has Google OAuth linked
            const googleOAuth = await getOAuthAccount(ctx.session.user.id, "google");

            if (googleOAuth) {
              // Check if user has granted both required scopes:
              // - documents.readonly for native Google Docs via Docs API
              // - drive.readonly for uploaded .docx files via Drive API
              const [hasDocsApiScope, hasDriveScope] = await Promise.all([
                hasGoogleScope(ctx.session.user.id, GOOGLE_DOCS_READONLY_SCOPE),
                hasGoogleScope(ctx.session.user.id, GOOGLE_DRIVE_SCOPE),
              ]);

              if (!hasDocsApiScope || !hasDriveScope) {
                // User has Google OAuth but hasn't granted required permissions
                logger.debug("User needs to grant Google Docs permissions", {
                  userId: ctx.session.user.id,
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

              // User has the required scope, try fetching with their token
              try {
                logger.debug("Attempting private Google Docs fetch with user OAuth", {
                  userId: ctx.session.user.id,
                  docId,
                });
                const accessToken = await getValidGoogleToken(ctx.session.user.id);
                googleDocsContent = await fetchPrivateGoogleDoc(docId, accessToken, tabId);

                if (googleDocsContent) {
                  html = `<!DOCTYPE html><html><head><title>${escapeHtml(googleDocsContent.title)}</title></head><body>${googleDocsContent.html}</body></html>`;
                  logger.debug("Successfully fetched private Google Docs content", {
                    userId: ctx.session.user.id,
                    docId: googleDocsContent.docId,
                    title: googleDocsContent.title,
                  });
                }
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
                // Other errors - continue to fallback
                logger.warn("Failed to fetch private Google Doc with OAuth", {
                  userId: ctx.session.user.id,
                  docId,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            } else {
              // User doesn't have Google OAuth linked
              logger.debug("User needs to sign in with Google for private docs", {
                userId: ctx.session.user.id,
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
          }

          // If we still don't have content, fall back to normal HTML fetch
          if (!googleDocsContent) {
            logger.debug("Google Docs API fetch failed, falling back to normal fetch", {
              url: normalizedUrl,
            });
            try {
              html = await fetchHtmlPage(normalizedUrl);
            } catch (error) {
              logger.warn("Failed to fetch Google Docs URL", {
                url: normalizedUrl,
                error: error instanceof Error ? error.message : String(error),
              });
              throw errors.savedArticleFetchError(
                normalizedUrl,
                error instanceof Error ? error.message : "Unknown error"
              );
            }
          }
        }
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
            html = await fetchHtmlPage(input.url);
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
      } else if (isArxivTransformableUrl(input.url)) {
        // For ArXiv abs/pdf URLs, try to fetch the HTML version if available
        logger.debug("Attempting ArXiv HTML version fetch", { url: input.url });
        const arxivFetchUrl = await getArxivFetchUrl(input.url);

        // arxivFetchUrl is either the HTML version (if it exists) or the abs page
        const urlToFetch = arxivFetchUrl ?? input.url;
        logger.debug("ArXiv fetch URL determined", {
          originalUrl: input.url,
          fetchUrl: urlToFetch,
          isHtmlVersion: arxivFetchUrl?.includes("/html/") ?? false,
        });

        try {
          html = await fetchHtmlPage(urlToFetch);
        } catch (error) {
          logger.warn("Failed to fetch ArXiv URL", {
            url: urlToFetch,
            originalUrl: input.url,
            error: error instanceof Error ? error.message : String(error),
          });
          throw errors.savedArticleFetchError(
            input.url,
            error instanceof Error ? error.message : "Unknown error"
          );
        }
      } else {
        try {
          html = await fetchHtmlPage(input.url);
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

      // Ensure we have HTML content at this point
      if (!html) {
        throw errors.savedArticleFetchError(input.url, "Failed to fetch content");
      }

      // Extract metadata (for LessWrong, we already have better metadata from GraphQL)
      const metadata = extractMetadata(html, input.url);

      // Run Readability for clean content (also absolutizes URLs internally)
      // Skip for Google Docs API content - it's already clean and structured
      // For LessWrong, the GraphQL content is already clean, but Readability will still
      // absolutize URLs and provide consistent output format
      const cleaned = googleDocsContent ? null : cleanContent(html, { url: input.url });

      // Generate excerpt
      let excerpt: string | null = null;
      if (googleDocsContent) {
        // For Google Docs API content, extract text from the HTML for excerpt
        const textMatch = googleDocsContent.html
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        excerpt = textMatch.slice(0, 300).trim() || null;
        if (excerpt && excerpt.length > 297) {
          excerpt = excerpt.slice(0, 297) + "...";
        }
      } else if (cleaned) {
        excerpt = cleaned.excerpt || cleaned.textContent.slice(0, 300).trim() || null;
        if (excerpt && excerpt.length > 300) {
          excerpt = excerpt.slice(0, 297) + "...";
        }
      }

      // Use provided title, then API data (Google Docs/LessWrong), then metadata, then Readability as fallback
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
      // For Google Docs, prefer API title over browser-provided title (which includes " - Google Docs" suffix)
      const finalTitle =
        googleDocsContent?.title ||
        input.title ||
        lessWrongTitle ||
        metadata.title ||
        cleaned?.title ||
        null;
      // For author, prefer API data (Google Docs/LessWrong), then metadata
      const finalAuthor =
        googleDocsContent?.author ||
        lessWrongContent?.author ||
        metadata.author ||
        cleaned?.byline ||
        null;
      // For siteName, use appropriate source when content came from API
      const finalSiteName = googleDocsContent
        ? "Google Docs"
        : lessWrongContent
          ? "LessWrong"
          : metadata.siteName;
      // Saved articles don't have a publishedAt - they use fetchedAt (when saved)
      // This ensures consistent sorting by save time in all views

      // For Google Docs API content, use the HTML directly (already clean and structured)
      const finalContentCleaned = googleDocsContent?.html || cleaned?.content || null;

      // Compute content hash for narration deduplication
      const contentHash = generateContentHash(finalTitle, finalContentCleaned || html);

      // Create the saved article entry
      const entryId = generateUuidv7();
      await ctx.db.insert(entries).values({
        id: entryId,
        feedId: savedFeedId,
        type: "saved",
        guid: normalizedUrl, // For saved articles, guid = normalized URL
        url: normalizedUrl,
        title: finalTitle,
        author: finalAuthor,
        contentOriginal: html,
        contentCleaned: finalContentCleaned,
        summary: excerpt,
        siteName: finalSiteName,
        imageUrl: metadata.imageUrl,
        publishedAt: null,
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
      });

      // Publish event to notify other browser windows/tabs
      await publishSavedArticleCreated(userId, entryId);

      return {
        article: {
          id: entryId,
          url: normalizedUrl,
          title: finalTitle,
          siteName: finalSiteName,
          author: finalAuthor,
          imageUrl: metadata.imageUrl,
          contentOriginal: html,
          contentCleaned: finalContentCleaned,
          excerpt,
          read: false,
          starred: false,
          savedAt: now,
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
