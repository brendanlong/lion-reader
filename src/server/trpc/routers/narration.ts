/**
 * Narration Router
 *
 * Handles narration generation for entries and saved articles.
 * Uses LLM preprocessing to convert article content to TTS-ready text.
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure, publicProcedure } from "../trpc";
import { errors } from "../errors";
import { entries, narrationContent, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateNarration,
  htmlToNarrationInput,
  isGroqAvailable,
  type ParagraphMapEntry,
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
 */
const generateInputSchema = z.object({
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
 * Maps a narration paragraph index to the original HTML element index.
 */
const paragraphMapEntrySchema = z.object({
  /** Narration paragraph index */
  n: z.number(),
  /** Original HTML element index (corresponds to data-para-id) */
  o: z.number(),
});

/**
 * Narration generation result schema.
 */
const generateOutputSchema = z.object({
  narration: z.string(),
  cached: z.boolean(),
  source: z.enum(["llm", "fallback"]),
  /**
   * Paragraph mapping for highlighting.
   * Maps each narration paragraph index to its original HTML element index.
   */
  paragraphMap: z.array(paragraphMapEntrySchema),
});

// ============================================================================
// Router
// ============================================================================

export const narrationRouter = createTRPCRouter({
  /**
   * Generate narration for an entry.
   *
   * Looks up existing narration by content hash for deduplication.
   * If not found or needs regeneration, calls LLM to generate narration.
   * Falls back to plain text conversion if LLM is unavailable or errors.
   *
   * @param id - The entry ID
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

      // Fetch the entry with visibility check via user_entries join
      // Both regular entries and saved articles are in the entries table now
      const entryResult = await ctx.db
        .select({
          id: entries.id,
          contentFull: entries.contentFull,
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
      // Use full content if available, otherwise fall back to cleaned/original
      const sourceContent =
        entry.contentFull || entry.contentCleaned || entry.contentOriginal || "";
      const contentHash = entry.contentHash;

      // Handle empty content
      if (!sourceContent.trim()) {
        trackNarrationGenerated(false, "fallback");
        return {
          narration: "",
          cached: false,
          source: "fallback" as const,
          paragraphMap: [],
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
        // Regenerate paragraph mapping from the source content
        // We need this because we don't cache the mapping in the database
        const { paragraphs } = htmlToNarrationInput(sourceContent);
        // Count paragraphs in cached narration to build the mapping
        const cachedParagraphs = narrationRecord.contentNarration
          .split(/\n\n+/)
          .filter((p) => p.trim().length > 0);
        // Build mapping: assume 1:1 correspondence with non-empty input paragraphs
        // This works because the LLM maintains paragraph order
        const paragraphMap: ParagraphMapEntry[] = [];
        let narrationIdx = 0;
        for (const p of paragraphs) {
          if (narrationIdx < cachedParagraphs.length) {
            paragraphMap.push({ n: narrationIdx, o: p.id });
            narrationIdx++;
          }
        }
        return {
          narration: narrationRecord.contentNarration,
          cached: true,
          source: "llm" as const,
          paragraphMap,
        };
      }

      // Check if we should retry after a previous error
      const canRetryLLM =
        !narrationRecord.errorAt || Date.now() - narrationRecord.errorAt.getTime() > RETRY_AFTER_MS;

      // If user disabled LLM normalization, Groq is not configured, or we had a recent error, fall back to plain text
      if (!input.useLlmNormalization || !isGroqAvailable() || !canRetryLLM) {
        // Generate narration with paragraph mapping using the same path as LLM
        const { paragraphs } = htmlToNarrationInput(sourceContent);
        const paragraphMap: ParagraphMapEntry[] = paragraphs.map((p, idx) => ({
          n: idx,
          o: p.id,
        }));
        const fallbackText = paragraphs.map((p) => p.text).join("\n\n");
        trackNarrationGenerated(false, "fallback");
        return {
          narration: fallbackText,
          cached: false,
          source: "fallback" as const,
          paragraphMap,
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
        await ctx.db
          .update(narrationContent)
          .set({
            contentNarration: result.text,
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

        // Fall back to plain text with paragraph mapping
        const { paragraphs } = htmlToNarrationInput(sourceContent);
        const paragraphMap: ParagraphMapEntry[] = paragraphs.map((p, idx) => ({
          n: idx,
          o: p.id,
        }));
        const fallbackText = paragraphs.map((p) => p.text).join("\n\n");
        trackNarrationGenerated(false, "fallback");
        return {
          narration: fallbackText,
          cached: false,
          source: "fallback" as const,
          paragraphMap,
        };
      }
    }),

  /**
   * Check if AI text processing is available.
   *
   * Returns true if GROQ_API_KEY is configured, meaning users can use
   * LLM-based text normalization for higher quality narration.
   */
  isAiTextProcessingAvailable: publicProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/narration/ai-available",
        tags: ["Narration"],
        summary: "Check if AI text processing is available",
      },
    })
    .input(z.void())
    .output(z.object({ available: z.boolean() }))
    .query(() => {
      return { available: isGroqAvailable() };
    }),
});
