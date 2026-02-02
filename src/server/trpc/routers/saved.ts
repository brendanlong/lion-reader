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
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, protectedProcedure, scopedProtectedProcedure } from "../trpc";
import { API_TOKEN_SCOPES } from "@/server/auth";
import { errors } from "../errors";
import { fetchHtmlPage, HttpFetchError } from "@/server/http/fetch";
import { markdownToHtml } from "@/server/markdown";
import { escapeHtml, extractTextFromHtml } from "@/server/http/html";
import { entries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { normalizeUrl } from "@/lib/url";
import { cleanContent } from "@/server/feed/content-cleaner";
import { getOrCreateSavedFeed } from "@/server/feed/saved-feed";
import { generateSummary } from "@/server/html/strip-html";
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
import { publishNewEntry, publishEntryUpdatedFromEntry } from "@/server/redis/pubsub";
import * as countsService from "@/server/services/counts";
import {
  processUploadedFile,
  detectFileType,
  getSupportedTypesDescription,
} from "@/server/file/process-upload";
import { pluginRegistry } from "@/server/plugins";
import { generateContentHash, createUploadedArticle } from "@/server/services/saved";

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
 * URL is nullable for uploaded files which don't have a source URL.
 */
const savedArticleFullSchema = z.object({
  id: z.string(),
  url: z.string().nullable(),
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

/**
 * Schema for unread counts returned from saved article mutations.
 * Saved articles only affect all, starred, and saved counts (no subscription/tags).
 */
const savedUnreadCountsSchema = z.object({
  all: z.object({ total: z.number(), unread: z.number() }),
  starred: z.object({ total: z.number(), unread: z.number() }),
  saved: z.object({ total: z.number(), unread: z.number() }),
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
  save: scopedProtectedProcedure(API_TOKEN_SCOPES.SAVED_WRITE)
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
        /** When true (default), re-fetch and update if URL is already saved */
        refetch: z.boolean().default(true),
        /** When true with refetch, update even if new content appears lower quality */
        force: z.boolean().optional(),
      })
    )
    .output(z.object({ article: savedArticleFullSchema, counts: savedUnreadCountsSchema }))
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

      // Track existing entry for refetch comparison
      let existingEntry: (typeof existing)[0] | null = null;

      if (existing.length > 0) {
        if (!input.refetch) {
          // Return existing article instead of error
          const { entry, userState } = existing[0];
          // Get counts for existing entry
          const counts = await countsService.getEntryRelatedCounts(ctx.db, userId, entry.id);
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
            counts: {
              all: counts.all,
              starred: counts.starred,
              saved: counts.saved!,
            },
          };
        }
        // refetch=true: continue to fetch new content and compare
        existingEntry = existing[0];
      }

      // Use provided HTML or fetch the page
      let html: string | undefined;
      // For Google Docs URLs, we may get content from the Google Docs API
      let googleDocsContent: GoogleDocsContent | null = null;
      // For plugin-handled URLs, we may get content from a plugin
      let pluginContent: {
        html: string;
        title?: string | null;
        author?: string | null;
        siteName?: string;
        publishedAt?: Date | null;
      } | null = null;

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
              const result = await fetchHtmlPage(normalizedUrl);
              html = result.isMarkdown ? await markdownToHtml(result.content) : result.content;
            } catch (error) {
              logger.warn("Failed to fetch Google Docs URL", {
                url: normalizedUrl,
                error: error instanceof Error ? error.message : String(error),
              });
              if (error instanceof HttpFetchError && error.isBlocked()) {
                throw errors.siteBlocked(normalizedUrl, error.status);
              }
              throw errors.savedArticleFetchError(
                normalizedUrl,
                error instanceof Error ? error.message : "Unknown error"
              );
            }
          }
        }
      } else {
        // For all other URLs, use the plugin system
        // LessWrong and ArXiv are now handled by plugins, no need for special cases
        // Check if a plugin can handle this URL
        let urlObj: URL | null = null;
        try {
          urlObj = new URL(input.url);
        } catch {
          // Invalid URL, continue to normal fetch
        }

        const plugin = urlObj ? pluginRegistry.findWithCapability(urlObj, "savedArticle") : null;

        if (plugin) {
          logger.debug("Attempting plugin fetch for saved article", {
            url: input.url,
            plugin: plugin.name,
          });

          try {
            const content = await plugin.capabilities.savedArticle.fetchContent(urlObj!, {});
            if (content) {
              pluginContent = {
                html: content.html,
                title: content.title,
                author: content.author,
                siteName: plugin.capabilities.savedArticle.siteName,
                publishedAt: content.publishedAt,
              };
              html = content.html;
              logger.debug("Successfully fetched content via plugin", {
                url: input.url,
                plugin: plugin.name,
                title: content.title,
              });
            }
          } catch (error) {
            logger.warn("Plugin fetch failed, falling back to normal fetch", {
              url: input.url,
              plugin: plugin.name,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        // Fall back to normal HTML fetch if plugin didn't provide content
        if (!html) {
          try {
            const result = await fetchHtmlPage(input.url);
            html = result.isMarkdown ? await markdownToHtml(result.content) : result.content;
          } catch (error) {
            logger.warn("Failed to fetch URL for saved article", {
              url: input.url,
              error: error instanceof Error ? error.message : String(error),
            });
            // Check if this is a blocked site error (403, 429, etc.)
            if (error instanceof HttpFetchError && error.isBlocked()) {
              throw errors.siteBlocked(input.url, error.status);
            }
            throw errors.savedArticleFetchError(
              input.url,
              error instanceof Error ? error.message : "Unknown error"
            );
          }
        }
      }

      // Ensure we have HTML content at this point
      if (!html) {
        throw errors.savedArticleFetchError(input.url, "Failed to fetch content");
      }

      // Extract metadata (for LessWrong, we already have better metadata from GraphQL)
      const metadata = extractMetadata(html, input.url);

      // Run Readability for clean content (also absolutizes URLs internally)
      // Skip for Google Docs API content and plugin content - already clean and structured
      // For LessWrong, the GraphQL content is already clean, but Readability will still
      // absolutize URLs and provide consistent output format
      const cleaned =
        googleDocsContent || pluginContent ? null : cleanContent(html, { url: input.url });

      // Generate excerpt
      let excerpt: string | null = null;
      if (googleDocsContent) {
        // For Google Docs API content, use generateSummary which properly decodes HTML entities
        excerpt = generateSummary(googleDocsContent.html) || null;
      } else if (pluginContent) {
        // For plugin content, use generateSummary
        excerpt = generateSummary(pluginContent.html) || null;
      } else if (cleaned) {
        excerpt = cleaned.excerpt || cleaned.textContent.slice(0, 300).trim() || null;
        if (excerpt && excerpt.length > 300) {
          excerpt = excerpt.slice(0, 297) + "...";
        }
      }

      // Use provided title, then API data (Google Docs/LessWrong), then metadata, then Readability as fallback
      // For Google Docs, prefer API title over browser-provided title (which includes " - Google Docs" suffix)
      // For other sources, prefer plugin data, then provided title, then metadata
      const finalTitle =
        googleDocsContent?.title ||
        pluginContent?.title ||
        input.title ||
        metadata.title ||
        cleaned?.title ||
        null;
      // For author, prefer API data (Google Docs/Plugin), then metadata
      const finalAuthor =
        googleDocsContent?.author ||
        pluginContent?.author ||
        metadata.author ||
        cleaned?.byline ||
        null;
      // For siteName, use appropriate source when content came from API
      const finalSiteName = googleDocsContent
        ? "Google Docs"
        : pluginContent?.siteName || metadata.siteName;
      // Saved articles don't have a publishedAt - they use fetchedAt (when saved)
      // This ensures consistent sorting by save time in all views

      // For API/plugin content, use the HTML directly (already clean and structured)
      const finalContentCleaned =
        googleDocsContent?.html || pluginContent?.html || cleaned?.content || null;

      // Compute content hash for narration deduplication
      const contentHash = generateContentHash(finalTitle, finalContentCleaned || html);

      // Handle refetch case: update existing entry if quality is acceptable
      if (existingEntry) {
        const { entry: oldEntry, userState } = existingEntry;

        // Compare content quality to avoid overwriting good content with bad
        // (e.g., private Google Doc fetched with auth, refetched without)
        if (!input.force) {
          const oldTextLength = oldEntry.contentCleaned
            ? extractTextFromHtml(oldEntry.contentCleaned).length
            : 0;

          // Get new text length from cleaned content or fall back to HTML
          const newTextLength = googleDocsContent
            ? extractTextFromHtml(googleDocsContent.html).length
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

        // Update the existing entry with new content
        await ctx.db
          .update(entries)
          .set({
            title: finalTitle,
            author: finalAuthor,
            contentOriginal: html,
            contentCleaned: finalContentCleaned,
            summary: excerpt,
            siteName: finalSiteName,
            imageUrl: metadata.imageUrl,
            contentHash,
            updatedAt: now,
          })
          .where(eq(entries.id, oldEntry.id));

        // Mark as unread since content was updated
        await ctx.db
          .update(userEntries)
          .set({ read: false })
          .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, oldEntry.id)));

        logger.info("Refetched saved article", {
          entryId: oldEntry.id,
          url: normalizedUrl,
          forced: input.force ?? false,
        });

        // Publish event to notify other browser windows/tabs of the update
        await publishEntryUpdatedFromEntry(savedFeedId, {
          id: oldEntry.id,
          title: finalTitle,
          author: finalAuthor,
          summary: excerpt,
          url: normalizedUrl,
          publishedAt: oldEntry.publishedAt,
          updatedAt: now,
        });

        // Get counts after update
        const counts = await countsService.getEntryRelatedCounts(ctx.db, userId, oldEntry.id);

        return {
          article: {
            id: oldEntry.id,
            url: normalizedUrl,
            title: finalTitle,
            siteName: finalSiteName,
            author: finalAuthor,
            imageUrl: metadata.imageUrl,
            contentOriginal: html,
            contentCleaned: finalContentCleaned,
            excerpt,
            read: false, // Marked unread since content was updated
            starred: userState.starred,
            savedAt: oldEntry.fetchedAt, // Keep original save time
          },
          counts: {
            all: counts.all,
            starred: counts.starred,
            saved: counts.saved!,
          },
        };
      }

      // Create new saved article entry
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
      await publishNewEntry(savedFeedId, entryId, now, "saved");

      // Get counts after creating new entry
      const counts = await countsService.getNewEntryRelatedCounts(ctx.db, userId, "saved", null);

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
        counts: {
          all: counts.all,
          starred: counts.starred,
          saved: counts.saved!,
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
   * Upload a file to save for later reading.
   *
   * Supports Word documents (.docx), HTML files, and Markdown files.
   * Files are processed and converted to HTML for consistent rendering:
   * - .docx: Converted via mammoth, then cleaned with Readability
   * - .html: Cleaned with Readability
   * - .md: Rendered to HTML via marked (preserved as-is semantically)
   *
   * @param content - Base64-encoded file content
   * @param filename - Original filename (used for type detection and title)
   * @param title - Optional title override
   * @returns The saved article
   */
  uploadFile: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/saved/upload",
        tags: ["Saved Articles"],
        summary: "Upload file to save for later",
      },
    })
    .input(
      z.object({
        content: z.string().min(1, "File content is required"),
        filename: z.string().min(1, "Filename is required"),
        title: z.string().optional(),
      })
    )
    .output(z.object({ article: savedArticleFullSchema, counts: savedUnreadCountsSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Validate file type
      const fileType = detectFileType(input.filename);
      if (!fileType) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Unsupported file type. ${getSupportedTypesDescription()}`,
        });
      }

      // Decode base64 content
      let fileBuffer: Buffer;
      try {
        fileBuffer = Buffer.from(input.content, "base64");
      } catch {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Invalid file content encoding. Expected base64.",
        });
      }

      // Process the file
      let processed;
      try {
        processed = await processUploadedFile(fileBuffer, input.filename);
      } catch (error) {
        logger.warn("Failed to process uploaded file", {
          filename: input.filename,
          fileType,
          error: error instanceof Error ? error.message : String(error),
        });
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Failed to process file: ${error instanceof Error ? error.message : "Unknown error"}`,
        });
      }

      // Determine site name based on file type
      const siteNameMap: Record<string, string> = {
        docx: "Uploaded Document",
        html: "Uploaded HTML",
        markdown: "Uploaded Text",
      };
      const siteName = siteNameMap[processed.fileType] || "Uploaded File";

      // Use provided title or extracted title
      const finalTitle = input.title || processed.title;

      // Create the uploaded article using the shared service
      const article = await createUploadedArticle(ctx.db, userId, {
        contentHtml: processed.contentCleaned,
        title: finalTitle,
        excerpt: processed.excerpt,
        siteName,
        author: processed.author,
      });

      logger.info("Uploaded file saved", {
        entryId: article.id,
        filename: input.filename,
        fileType: processed.fileType,
        title: finalTitle,
      });

      // Get counts after creating new entry
      const counts = await countsService.getNewEntryRelatedCounts(ctx.db, userId, "saved", null);

      return {
        article: {
          id: article.id,
          url: article.url,
          title: article.title,
          siteName: article.siteName,
          author: article.author,
          imageUrl: article.imageUrl,
          contentOriginal: article.contentCleaned, // Same as cleaned for uploads
          contentCleaned: article.contentCleaned,
          excerpt: article.excerpt,
          read: article.read,
          starred: article.starred,
          savedAt: article.savedAt,
        },
        counts: {
          all: counts.all,
          starred: counts.starred,
          saved: counts.saved!,
        },
      };
    }),
});
