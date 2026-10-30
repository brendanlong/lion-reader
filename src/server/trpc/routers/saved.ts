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
 * - entries.countLists (the web sidebar) or entries.count({ type: 'saved' }) for counts
 * - entries.markRead, entries.setStarred for mutations
 *
 * This router only handles:
 * - saved.save: Save a URL (content extraction in services/saved.ts)
 * - saved.delete: Hard delete a saved article (entries use soft delete)
 * - saved.uploadFile: Upload a file (.docx/.pdf/.html/.md) as a saved article
 *
 * Business logic lives in the saved service (`@/server/services/saved`),
 * shared with the MCP save_article/delete_saved_article/upload_article tools.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { createTRPCRouter, scopedProtectedProcedure, uploadProcedure } from "../trpc";
import { READER_SCOPES, SAVE_ARTICLE_SCOPES } from "@/server/auth/api-token";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import { errors } from "@/server/errors";
import {
  savedArticleUrlSchema,
  saveCollectionIdsSchema,
  uploadContentSchema,
  uploadIdempotencyKeySchema,
  uuidSchema,
} from "../validation";
import { usageLimitsConfig } from "@/server/config/env";
import { newEntryListItemSchema, unreadCountsSchema } from "@/lib/events/schemas";
import { getBulkEntryRelatedCounts, type BulkUnreadCounts } from "@/server/services/counts";
import * as savedService from "@/server/services/saved";

// Saved-article management is part of the MCP tool surface, which the app shares.
const readerProcedure = scopedProtectedProcedure(READER_SCOPES);

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

/** The counts of the lists a saved article is in: the global ones and its collections. */
function savedArticleCounts(
  db: Parameters<typeof getBulkEntryRelatedCounts>[0],
  userId: string,
  articleId: string
): Promise<BulkUnreadCounts> {
  return getBulkEntryRelatedCounts(db, userId, [{ id: articleId, subscriptionId: null }]);
}

// ============================================================================
// Router
// ============================================================================
//
// Mutations return the service article directly; the .output() schema
// (savedArticleMetadataSchema) strips the body and internal fields
// (contentCleaned, outcome) from the response.

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
        url: savedArticleUrlSchema,
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
        collectionIds: saveCollectionIdsSchema,
      })
    )
    .output(
      z.object({
        article: savedService.savedArticleMetadataSchema,
        counts: unreadCountsSchema,
      })
    )
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

      return { article, counts: await savedArticleCounts(ctx.db, userId, article.id) };
    }),

  /**
   * Delete a saved article (hard delete).
   *
   * Saved articles are per-user, so hard delete is safe.
   * Deleting the entry will cascade to user_entries.
   *
   * @param id - The saved article ID to delete
   * @returns The counts of the lists it left
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
    .output(z.object({ counts: unreadCountsSchema }))
    .mutation(async ({ ctx, input }) => {
      const counts = await savedService.deleteSavedArticle(ctx.db, ctx.session.user.id, input.id);
      if (counts === null) {
        throw errors.savedArticleNotFound();
      }
      return { counts };
    }),

  /**
   * Upload a file to save for later reading.
   *
   * Supports Word documents (.docx), PDFs, HTML files, and Markdown files.
   * Files are processed and converted to HTML for consistent rendering:
   * - .docx: Converted via mammoth; title/author/summary read from the document's
   *   `docProps/core.xml`; Readability skipped (already clean content)
   * - .pdf: Text and layout extracted to Markdown; title/author/summary read
   *   from the document info; Readability skipped
   * - .html: Cleaned with Readability
   * - .md: Rendered to HTML (preserved as-is semantically)
   *
   * @param content - Base64-encoded file content
   * @param filename - Original filename (used for type detection and title)
   * @param title - Optional title override
   * @returns The saved article
   */
  uploadFile: uploadProcedure
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
        content: uploadContentSchema,
        filename: z.string().min(1, "Filename is required"),
        title: z.string().optional(),
        idempotencyKey: uploadIdempotencyKeySchema,
        collectionIds: saveCollectionIdsSchema,
      })
    )
    .output(
      z.object({
        article: savedService.savedArticleMetadataSchema,
        // The article's list item, as its new_entry event carries it.
        listItem: newEntryListItemSchema,
        counts: unreadCountsSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const { article, listItem } = await savedService.uploadFile(ctx.db, userId, input);
      return {
        article,
        listItem,
        counts: await savedArticleCounts(ctx.db, userId, article.id),
      };
    }),
});
