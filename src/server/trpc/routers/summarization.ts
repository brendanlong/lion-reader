/**
 * Summarization Router
 *
 * Handles AI-powered article summarization.
 * Uses Anthropic Claude for generating concise summaries.
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { errors } from "../errors";
import { entries, entrySummaries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateSummary,
  isSummarizationAvailable,
  prepareContentForSummarization,
  CURRENT_PROMPT_VERSION,
} from "@/server/services/summarization";
import { logger } from "@/lib/logger";

// ============================================================================
// Constants
// ============================================================================

/**
 * Time to wait before retrying after an error (1 hour in milliseconds).
 */
const RETRY_AFTER_MS = 60 * 60 * 1000;

// ============================================================================
// Validation Schemas
// ============================================================================

/**
 * UUID validation schema.
 */
const uuidSchema = z.string().uuid("Invalid ID");

/**
 * Input for summary generation.
 */
const generateInputSchema = z.object({
  entryId: uuidSchema,
});

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Summary generation result schema.
 */
const generateOutputSchema = z.object({
  summary: z.string(),
  cached: z.boolean(),
  modelId: z.string(),
  generatedAt: z.date().nullable(),
});

// ============================================================================
// Router
// ============================================================================

export const summarizationRouter = createTRPCRouter({
  /**
   * Generate a summary for an entry.
   *
   * Looks up existing summary by content hash for deduplication.
   * If not found or stale, calls LLM to generate summary.
   *
   * @param entryId - The entry ID
   * @returns Summary text, whether it was cached, model ID, and generation time
   */
  generate: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/summarization/generate",
        tags: ["Summarization"],
        summary: "Generate AI summary for article",
      },
    })
    .input(generateInputSchema)
    .output(generateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Check if summarization is available
      if (!isSummarizationAvailable()) {
        throw errors.internal("AI summarization is not configured on this server");
      }

      // Fetch the entry with visibility check via user_entries join
      const entryResult = await ctx.db
        .select({
          id: entries.id,
          contentCleaned: entries.contentCleaned,
          contentOriginal: entries.contentOriginal,
          contentHash: entries.contentHash,
          fullContentCleaned: entries.fullContentCleaned,
        })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(and(eq(entries.id, input.entryId), eq(userEntries.userId, userId)))
        .limit(1);

      if (entryResult.length === 0) {
        throw errors.entryNotFound();
      }

      const entry = entryResult[0];

      // Prefer full content (fetched from URL) over feed content
      const sourceContent =
        entry.fullContentCleaned || entry.contentCleaned || entry.contentOriginal || "";
      const contentHash = entry.contentHash;

      // Handle empty content
      if (!sourceContent.trim()) {
        throw errors.validation("Entry has no content to summarize");
      }

      // Look up existing summary by content hash
      let summary = await ctx.db
        .select()
        .from(entrySummaries)
        .where(eq(entrySummaries.contentHash, contentHash))
        .limit(1);

      // Create placeholder record if not found
      if (summary.length === 0) {
        const newId = generateUuidv7();
        await ctx.db.insert(entrySummaries).values({
          id: newId,
          contentHash,
          promptVersion: CURRENT_PROMPT_VERSION,
          createdAt: new Date(),
        });

        summary = await ctx.db
          .select()
          .from(entrySummaries)
          .where(eq(entrySummaries.id, newId))
          .limit(1);
      }

      const summaryRecord = summary[0];

      // Check if summary is stale (different prompt version)
      const isStale = summaryRecord.promptVersion !== CURRENT_PROMPT_VERSION;

      // Return cached summary if available and not stale
      if (summaryRecord.summaryText && !isStale) {
        return {
          summary: summaryRecord.summaryText,
          cached: true,
          modelId: summaryRecord.modelId || "unknown",
          generatedAt: summaryRecord.generatedAt,
        };
      }

      // Check if we should retry after a previous error
      const canRetry =
        !summaryRecord.errorAt || Date.now() - summaryRecord.errorAt.getTime() > RETRY_AFTER_MS;

      if (!canRetry) {
        throw errors.internal(
          `Summarization failed recently. Please try again later. Error: ${summaryRecord.error}`
        );
      }

      try {
        // Prepare content for summarization (convert to plain text, truncate if needed)
        const preparedContent = prepareContentForSummarization(sourceContent);

        // Generate via LLM
        const result = await generateSummary(preparedContent);

        // Cache in entry_summaries table, clear any previous error
        await ctx.db
          .update(entrySummaries)
          .set({
            summaryText: result.summary,
            modelId: result.modelId,
            promptVersion: CURRENT_PROMPT_VERSION,
            generatedAt: new Date(),
            error: null,
            errorAt: null,
          })
          .where(eq(entrySummaries.id, summaryRecord.id));

        return {
          summary: result.summary,
          cached: false,
          modelId: result.modelId,
          generatedAt: new Date(),
        };
      } catch (error) {
        // Log the error
        logger.error("Summary generation failed", {
          contentHash,
          error: error instanceof Error ? error.message : String(error),
        });

        // Store error in entry_summaries for retry tracking
        await ctx.db
          .update(entrySummaries)
          .set({
            error: error instanceof Error ? error.message : "Unknown error",
            errorAt: new Date(),
          })
          .where(eq(entrySummaries.id, summaryRecord.id));

        throw errors.internal(
          `Failed to generate summary: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }),

  /**
   * Check if AI summarization is available.
   *
   * Returns true if ANTHROPIC_API_KEY is configured.
   */
  isAvailable: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/summarization/available",
        tags: ["Summarization"],
        summary: "Check if AI summarization is available",
      },
    })
    .input(z.void())
    .output(z.object({ available: z.boolean() }))
    .query(() => {
      return { available: isSummarizationAvailable() };
    }),
});
