/**
 * Narration Router
 *
 * Handles narration generation for entries and saved articles.
 * Uses LLM preprocessing to convert article content to TTS-ready text.
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { entries, savedArticles, narrationContent, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateNarration,
  htmlToPlainText,
  computeContentHash,
  isGroqAvailable,
} from "@/server/services/narration";
import { logger } from "@/lib/logger";
import {
  trackNarrationGenerated,
  trackNarrationGenerationError,
  startNarrationGenerationTimer,
} from "@/server/metrics";

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
 * Input for narration generation.
 * Supports both feed entries and saved articles.
 */
const generateInputSchema = z.object({
  type: z.enum(["entry", "saved"]),
  id: uuidSchema,
  /**
   * Whether to use LLM preprocessing for better narration quality.
   * When false, uses simple HTML-to-text conversion.
   * Defaults to true if not specified.
   */
  useLlmNormalization: z.boolean().optional().default(true),
});

// ============================================================================
// Output Schemas
// ============================================================================

/**
 * Paragraph mapping entry schema.
 * Maps a narration paragraph index to one or more original paragraph indices.
 */
const paragraphMappingSchema = z.object({
  n: z.number(), // narration paragraph index
  o: z.array(z.number()), // original paragraph indices
});

/**
 * Narration generation result schema.
 */
const generateOutputSchema = z.object({
  narration: z.string(),
  cached: z.boolean(),
  source: z.enum(["llm", "fallback"]),
  paragraphMap: z.array(paragraphMappingSchema).nullable(),
});

// ============================================================================
// Router
// ============================================================================

export const narrationRouter = createTRPCRouter({
  /**
   * Generate narration for an entry or saved article.
   *
   * Looks up existing narration by content hash for deduplication.
   * If not found or needs regeneration, calls LLM to generate narration.
   * Falls back to plain text conversion if LLM is unavailable or errors.
   *
   * @param type - 'entry' for feed entries, 'saved' for saved articles
   * @param id - The entry or saved article ID
   * @returns Narration text, whether it was cached, and the source (llm or fallback)
   */
  generate: protectedProcedure
    .meta({
      openapi: {
        method: "POST",
        path: "/narration/generate",
        tags: ["Narration"],
        summary: "Generate narration for article",
      },
    })
    .input(generateInputSchema)
    .output(generateOutputSchema)
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;

      // Fetch the article based on type
      let sourceContent: string;
      let contentHash: string;

      if (input.type === "entry") {
        // Get the entry with visibility check via user_entries join
        const entryResult = await ctx.db
          .select({
            id: entries.id,
            contentCleaned: entries.contentCleaned,
            contentOriginal: entries.contentOriginal,
            contentHash: entries.contentHash,
          })
          .from(entries)
          .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
          .where(and(eq(entries.id, input.id), eq(userEntries.userId, userId)))
          .limit(1);

        if (entryResult.length === 0) {
          throw errors.entryNotFound();
        }

        const entry = entryResult[0];
        sourceContent = entry.contentCleaned || entry.contentOriginal || "";
        contentHash = entry.contentHash;
      } else {
        // Get the saved article
        const articleResult = await ctx.db
          .select({
            id: savedArticles.id,
            userId: savedArticles.userId,
            contentCleaned: savedArticles.contentCleaned,
            contentOriginal: savedArticles.contentOriginal,
            contentHash: savedArticles.contentHash,
          })
          .from(savedArticles)
          .where(and(eq(savedArticles.id, input.id), eq(savedArticles.userId, userId)))
          .limit(1);

        if (articleResult.length === 0) {
          throw errors.savedArticleNotFound();
        }

        const article = articleResult[0];
        sourceContent = article.contentCleaned || article.contentOriginal || "";

        // Compute content hash if not already stored
        contentHash = article.contentHash || computeContentHash(sourceContent);
      }

      // Handle empty content
      if (!sourceContent.trim()) {
        trackNarrationGenerated(false, "fallback");
        return {
          narration: "",
          cached: false,
          source: "fallback" as const,
          paragraphMap: null,
        };
      }

      // Look up existing narration by content hash
      let narration = await ctx.db
        .select()
        .from(narrationContent)
        .where(eq(narrationContent.contentHash, contentHash))
        .limit(1);

      // Create placeholder record if not found
      if (narration.length === 0) {
        const newId = generateUuidv7();
        await ctx.db.insert(narrationContent).values({
          id: newId,
          contentHash,
          createdAt: new Date(),
        });

        narration = await ctx.db
          .select()
          .from(narrationContent)
          .where(eq(narrationContent.id, newId))
          .limit(1);
      }

      const narrationRecord = narration[0];

      // Return cached narration if available
      if (narrationRecord.contentNarration) {
        trackNarrationGenerated(true, "llm");
        return {
          narration: narrationRecord.contentNarration,
          cached: true,
          source: "llm" as const,
          paragraphMap: narrationRecord.paragraphMap ?? null,
        };
      }

      // Check if we should retry after a previous error
      const canRetryLLM =
        !narrationRecord.errorAt || Date.now() - narrationRecord.errorAt.getTime() > RETRY_AFTER_MS;

      // If user disabled LLM normalization, Groq is not configured, or we had a recent error, fall back to plain text
      if (!input.useLlmNormalization || !isGroqAvailable() || !canRetryLLM) {
        const fallbackText = htmlToPlainText(sourceContent);
        trackNarrationGenerated(false, "fallback");
        return {
          narration: fallbackText,
          cached: false,
          source: "fallback" as const,
          paragraphMap: null,
        };
      }

      // Start timer for LLM generation duration
      const stopTimer = startNarrationGenerationTimer();

      try {
        // Generate via LLM
        const result = await generateNarration(sourceContent);

        // Stop the timer after generation completes
        stopTimer();

        // If LLM returned fallback (e.g., empty response), don't cache it
        // But still return the paragraph map from the fallback generation
        if (result.source === "fallback") {
          trackNarrationGenerated(false, "fallback");
          trackNarrationGenerationError("empty_response");
          return {
            narration: result.text,
            cached: false,
            source: "fallback" as const,
            paragraphMap: result.paragraphMap,
          };
        }

        // Cache in narration_content table, clear any previous error
        // Also store the paragraph map for highlighting support
        await ctx.db
          .update(narrationContent)
          .set({
            contentNarration: result.text,
            paragraphMap: result.paragraphMap,
            generatedAt: new Date(),
            error: null,
            errorAt: null,
          })
          .where(eq(narrationContent.id, narrationRecord.id));

        trackNarrationGenerated(false, "llm");
        return {
          narration: result.text,
          cached: false,
          source: "llm" as const,
          paragraphMap: result.paragraphMap,
        };
      } catch (error) {
        // Stop the timer even on error
        stopTimer();

        // Log the error
        logger.error("Narration generation failed", {
          contentHash,
          error: error instanceof Error ? error.message : String(error),
        });

        // Track the error
        trackNarrationGenerationError("api_error");

        // Store error in narration_content for retry tracking
        await ctx.db
          .update(narrationContent)
          .set({
            error: error instanceof Error ? error.message : "Unknown error",
            errorAt: new Date(),
          })
          .where(eq(narrationContent.id, narrationRecord.id));

        // Fall back to plain text
        const fallbackText = htmlToPlainText(sourceContent);
        trackNarrationGenerated(false, "fallback");
        return {
          narration: fallbackText,
          cached: false,
          source: "fallback" as const,
          paragraphMap: null,
        };
      }
    }),
});
