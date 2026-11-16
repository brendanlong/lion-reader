/**
 * Imports Router
 *
 * Handles OPML import status queries.
 * Allows users to check the status of their async OPML imports.
 */

import { z } from "zod";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import { errors } from "@/server/errors";
import { uuidSchema } from "../validation";
import { parseOpmlAsync, OpmlParseError } from "@/server/feed/opml";
import { getOpmlImport, listOpmlImports, MAX_OPML_BYTES } from "@/server/services/imports";

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Import result item schema.
 */
const importResultSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  status: z.enum(["pending", "imported", "skipped", "failed"]),
  error: z.string().optional(),
  subscriptionId: z.string().optional(),
});

/**
 * Import output schema - what we return for an import.
 */
const importOutputSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  totalFeeds: z.number(),
  importedCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  results: z.array(importResultSchema),
  error: z.string().nullable(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});

/**
 * Import summary schema (for list view, without full results).
 */
const importSummarySchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  totalFeeds: z.number(),
  importedCount: z.number(),
  skippedCount: z.number(),
  failedCount: z.number(),
  error: z.string().nullable(),
  createdAt: z.date(),
  completedAt: z.date().nullable(),
});

/**
 * A feed parsed out of an uploaded OPML file, for the import preview UI.
 */
const opmlPreviewFeedSchema = z.object({
  xmlUrl: z.string(),
  title: z.string().optional(),
  htmlUrl: z.string().optional(),
  category: z.array(z.string()).optional(),
});

// ============================================================================
// Router
// ============================================================================

export const importsRouter = createTRPCRouter({
  /**
   * Parse an OPML file and return the feeds it lists, without importing
   * anything. Backs the import preview UI — parsing happens server-side (on
   * the libuv thread pool) so the browser bundle carries no XML parser and
   * the app-server event loop isn't blocked by a large upload.
   */
  preview: protectedProcedure
    .input(
      z.object({
        opml: z
          .string()
          .min(1, "OPML content is required")
          .max(MAX_OPML_BYTES, "OPML file too large (max 5MB)"),
      })
    )
    .output(z.object({ feeds: z.array(opmlPreviewFeedSchema) }))
    .mutation(async ({ input }) => {
      try {
        return { feeds: await parseOpmlAsync(input.opml) };
      } catch (error) {
        if (error instanceof OpmlParseError) {
          throw errors.validation(`Failed to parse OPML: ${error.message}`);
        }
        throw error;
      }
    }),

  /**
   * Get a specific import by ID.
   *
   * Returns the full import record including all results.
   */
  get: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/imports/{id}",
        tags: ["Imports"],
        summary: "Get import details",
      },
    })
    .input(
      z.object({
        id: uuidSchema,
      })
    )
    .output(importOutputSchema)
    .query(({ ctx, input }) => getOpmlImport(ctx.db, ctx.session.user.id, input.id)),

  /**
   * List recent imports for the current user.
   *
   * Returns imports ordered by creation date (newest first).
   * Does not include full results to keep response size small.
   */
  list: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/imports",
        tags: ["Imports"],
        summary: "List imports",
      },
    })
    .input(
      z
        .object({
          limit: z.number().min(1).max(50).default(10),
        })
        .optional()
    )
    .output(
      z.object({
        items: z.array(importSummarySchema),
      })
    )
    .query(async ({ ctx, input }) => ({
      items: await listOpmlImports(ctx.db, ctx.session.user.id, input?.limit ?? 10),
    })),
});
