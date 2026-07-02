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
import { API_TOKEN_SCOPES } from "@/server/auth/api-token";
import { errors } from "../errors";
import { uuidSchema } from "../validation";
import { usageLimitsConfig } from "@/server/config/env";
import { logger } from "@/lib/logger";
import * as countsService from "@/server/services/counts";
import * as savedService from "@/server/services/saved";
import {
  processUploadedFile,
  detectFileType,
  getSupportedTypesDescription,
} from "@/server/file/process-upload";

// Saved-article reads/management are part of the MCP tool surface (`mcp` scope).
const mcpProcedure = scopedProtectedProcedure(API_TOKEN_SCOPES.MCP);

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
  save: scopedProtectedProcedure([API_TOKEN_SCOPES.SAVED_WRITE, API_TOKEN_SCOPES.MCP])
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
        /** When true (default), re-fetch and update if URL is already saved */
        refetch: z.boolean().default(true),
        /** When true with refetch, update even if new content appears lower quality */
        force: z.boolean().optional(),
      })
    )
    .output(z.object({ article: savedArticleFullSchema, counts: savedUnreadCountsSchema }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const article = await savedService.saveArticle(ctx.db, userId, {
        url: input.url,
        html: input.html,
        title: input.title,
        refetch: input.refetch,
        force: input.force,
        // The web UI can walk the user through Google sign-in / consent.
        googleDocsAuth: true,
      });

      const counts =
        article.outcome === "created"
          ? await countsService.getNewEntryRelatedCounts(ctx.db, userId, "saved", null)
          : await countsService.getEntryRelatedCounts(ctx.db, userId, article.id);

      return {
        article,
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
  delete: mcpProcedure
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
   * - .docx: Converted via mammoth, then cleaned with Readability
   * - .html: Cleaned with Readability
   * - .md: Rendered to HTML via marked (preserved as-is semantically)
   *
   * @param content - Base64-encoded file content
   * @param filename - Original filename (used for type detection and title)
   * @param title - Optional title override
   * @returns The saved article
   */
  uploadFile: mcpProcedure
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
      const article = await savedService.createUploadedArticle(ctx.db, userId, {
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
        article,
        counts: {
          all: counts.all,
          starred: counts.starred,
          saved: counts.saved!,
        },
      };
    }),
});
