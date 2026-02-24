/**
 * Imports Router
 *
 * Handles OPML import status queries.
 * Allows users to check the status of their async OPML imports.
 */

import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { uuidSchema } from "../validation";
import { opmlImports } from "@/server/db/schema";

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
  feedId: z.string().optional(),
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

// ============================================================================
// Router
// ============================================================================

export const importsRouter = createTRPCRouter({
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
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      const [importRecord] = await ctx.db
        .select()
        .from(opmlImports)
        .where(and(eq(opmlImports.id, input.id), eq(opmlImports.userId, userId)))
        .limit(1);

      if (!importRecord) {
        throw errors.notFound("Import not found");
      }

      return {
        id: importRecord.id,
        status: importRecord.status as "pending" | "processing" | "completed" | "failed",
        totalFeeds: importRecord.totalFeeds,
        importedCount: importRecord.importedCount,
        skippedCount: importRecord.skippedCount,
        failedCount: importRecord.failedCount,
        results: importRecord.results,
        error: importRecord.error,
        createdAt: importRecord.createdAt,
        completedAt: importRecord.completedAt,
      };
    }),

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
    .query(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const limit = input?.limit ?? 10;

      const imports = await ctx.db
        .select({
          id: opmlImports.id,
          status: opmlImports.status,
          totalFeeds: opmlImports.totalFeeds,
          importedCount: opmlImports.importedCount,
          skippedCount: opmlImports.skippedCount,
          failedCount: opmlImports.failedCount,
          error: opmlImports.error,
          createdAt: opmlImports.createdAt,
          completedAt: opmlImports.completedAt,
        })
        .from(opmlImports)
        .where(eq(opmlImports.userId, userId))
        .orderBy(desc(opmlImports.createdAt))
        .limit(limit);

      return {
        items: imports.map((imp) => ({
          id: imp.id,
          status: imp.status as "pending" | "processing" | "completed" | "failed",
          totalFeeds: imp.totalFeeds,
          importedCount: imp.importedCount,
          skippedCount: imp.skippedCount,
          failedCount: imp.failedCount,
          error: imp.error,
          createdAt: imp.createdAt,
          completedAt: imp.completedAt,
        })),
      };
    }),
});
