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
 * - saved.save: Save a URL (content extraction in services/saved.ts)
 * - saved.delete: Hard delete a saved article (entries use soft delete)
 * - saved.uploadFile: Upload a file (.docx/.html/.md) as a saved article
 *
 * Business logic lives in the saved service (`@/server/services/saved`),
 * shared with the MCP save_article/delete_saved_article/upload_article tools.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, scopedProtectedProcedure } from "../trpc";
import { READER_SCOPES, SAVE_ARTICLE_SCOPES } from "@/server/auth/api-token";
import { MAX_SAVE_COLLECTIONS } from "@/lib/collections";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { errors } from "@/server/errors";
import { uuidSchema } from "../validation";
import { usageLimitsConfig } from "@/server/config/env";
import type { db as dbType } from "@/server/db";
import { getGlobalUnreadCounts } from "@/server/services/counts";
import * as savedService from "@/server/services/saved";

// Saved-article management is part of the MCP tool surface, which the app shares.
const readerProcedure = scopedProtectedProcedure(READER_SCOPES);

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * URL validation schema.
 */
const urlSchema = z.string().url("Invalid URL");

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Saved article metadata returned from save/upload mutations.
 *
 * Deliberately omits the article body (`contentOriginal`/`contentCleaned`):
 * callers only use the metadata here (title etc.), and every body render goes
 * through `entries.get`, which sanitizes on the read path. Echoing raw bodies
 * back here would be a stored-XSS footgun for any future caller that rendered
 * them directly, with no upside since nothing reads them. See issue #927.
 * URL is nullable for uploaded files which don't have a source URL.
 */
const savedArticleFullSchema = z.object({
  id: z.string(),
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

/**
 * Schema for unread counts returned from saved article mutations.
 * Saved articles only affect all, starred, and saved counts (no subscription/tags).
 */
const savedUnreadCountsSchema = z.object({
  all: z.object({ unread: z.number() }),
  starred: z.object({ unread: z.number() }),
  saved: z.object({ unread: z.number() }),
});

/**
 * The absolute counts a saved-article mutation affects: saved articles have no
 * subscription or tags, so only the global counters move.
 */
async function getSavedUnreadCounts(
  db: typeof dbType,
  userId: string
): Promise<z.infer<typeof savedUnreadCountsSchema>> {
  const counts = await getGlobalUnreadCounts(db, userId);
  return {
    all: { unread: counts.allUnread },
    starred: { unread: counts.starredUnread },
    saved: { unread: counts.savedUnread },
  };
}

/** Collections to put a newly saved article in; checked before saving. */
const collectionIdsSchema = z.array(uuidSchema).max(MAX_SAVE_COLLECTIONS).optional();

/**
 * Changing collections needs a reader scope; the save-only `saved:write`
 * token may save but not file the article into collections.
 */
function assertMayChangeCollections(
  ctx: { authType: string | null; scopes: readonly string[] },
  collectionIds: string[] | undefined
): void {
  if (!collectionIds?.length || ctx.authType === "session") return;
  if (!READER_SCOPES.some((scope) => ctx.scopes.includes(scope))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Adding to collections requires the 'mcp' or 'reader:full-access' scope",
    });
  }
}

// ============================================================================
// Router
// ============================================================================
//
// Mutations return the service article directly; the .output() schema
// (savedArticleFullSchema) strips the body and internal fields (contentCleaned,
// outcome) from the response.

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
  // Also the native app's share target (`reader:full-access`).
  save: scopedProtectedProcedure([...SAVE_ARTICLE_SCOPES, OAUTH_SCOPES.READER_FULL_ACCESS])
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
        html: z
          .string()
          .max(
            usageLimitsConfig.maxSavedArticleSizeBytes,
            "Provided HTML exceeds the maximum saved article size"
          )
          .optional(),
        title: z.string().optional(),
        /** Optional author hint (highest-precedence author source); plain text. */
        author: z.string().optional(),
        /** Optional excerpt/summary hint (highest-precedence); plain text, clipped. */
        excerpt: z.string().optional(),
        /** When true (default), re-fetch and update if URL is already saved */
        refetch: z.boolean().default(true),
        /** When true with refetch, update even if new content appears lower quality */
        force: z.boolean().optional(),
        collectionIds: collectionIdsSchema,
      })
    )
    .output(z.object({ article: savedArticleFullSchema, counts: savedUnreadCountsSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      assertMayChangeCollections(ctx, input.collectionIds);

      const article = await savedService.saveArticle(ctx.db, userId, {
        ...input,
        // The web UI and the extension walk the user through Google sign-in /
        // consent, so they want the machine-readable NEEDS_* codes they match to
        // drive prompts; the app can't, so it gets the readable messages.
        userAuth: ctx.authType === "app_token" ? "non-interactive" : "interactive",
      });

      return { article, counts: await getSavedUnreadCounts(ctx.db, userId) };
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
  delete: readerProcedure
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
      const deleted = await savedService.deleteSavedArticle(ctx.db, ctx.session.user.id, input.id);
      if (!deleted) {
        throw errors.savedArticleNotFound();
      }
      return {};
    }),

  /**
   * Upload a file to save for later reading.
   *
   * Supports Word documents (.docx), HTML files, and Markdown files.
   * Files are processed and converted to HTML for consistent rendering:
   * - .docx: Converted via mammoth; title/author/summary read from the document's
   *   `docProps/core.xml`; Readability skipped (already clean content)
   * - .html: Cleaned with Readability
   * - .md: Rendered to HTML (preserved as-is semantically)
   *
   * @param content - Base64-encoded file content
   * @param filename - Original filename (used for type detection and title)
   * @param title - Optional title override
   * @returns The saved article
   */
  uploadFile: readerProcedure
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
        // Base64 inflates by ~4/3; cap the encoded string so an oversized upload
        // is rejected by validation before we spend memory/CPU decoding it. The
        // service enforces the decoded byte length exactly (base64 length is only an
        // upper bound on decoded size). Slack covers padding/newlines.
        content: z
          .string()
          .min(1, "File content is required")
          .max(
            Math.ceil((usageLimitsConfig.maxSavedArticleSizeBytes * 4) / 3) + 1024,
            "File content exceeds the maximum saved article size"
          ),
        filename: z.string().min(1, "Filename is required"),
        title: z.string().optional(),
        collectionIds: collectionIdsSchema,
      })
    )
    .output(z.object({ article: savedArticleFullSchema, counts: savedUnreadCountsSchema }))
    .mutation(async ({ ctx, input }) => {
      const article = await savedService.uploadFile(ctx.db, ctx.session.user.id, input);
      return { article, counts: await getSavedUnreadCounts(ctx.db, ctx.session.user.id) };
    }),
});
