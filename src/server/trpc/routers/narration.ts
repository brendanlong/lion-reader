/**
 * Narration Router
 *
 * Handles narration generation for entries and saved articles.
 * Uses LLM preprocessing to convert article content to TTS-ready text.
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { uuidSchema } from "../validation";
import { entries, narrationContent, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateNarration,
  htmlToNarrationInput,
  isGroqAvailable,
} from "@/server/services/narration";
import { buildAlignedNarration } from "@/lib/narration/paragraph-map";
import { getUserApiKeys } from "@/server/auth/session";
import { logger } from "@/lib/logger";
import {
  trackNarrationGenerated,
  trackNarrationGenerationError,
  startNarrationGenerationTimer,
} from "@/server/metrics/metrics";

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

      // Fetch API key from DB on demand (not cached in session for security)
      const { groqApiKey: userGroqApiKey } = await getUserApiKeys(userId);

      // Fetch the entry with visibility check via user_entries join
      // Both regular entries and saved articles are in the entries table now
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
        .where(and(eq(entries.id, input.id), eq(userEntries.userId, userId)))
        .limit(1);

      if (entryResult.length === 0) {
        throw errors.entryNotFound();
      }

      const entry = entryResult[0];
      // Prefer full content (fetched from URL) over feed content for narration
      const sourceContent =
        entry.fullContentCleaned || entry.contentCleaned || entry.contentOriginal || "";
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
        // Prefer the paragraph map persisted at generation time — it is the only
        // map guaranteed to align with the cached narration text. Legacy rows
        // (generated before the paragraph_map column existed) have no stored
        // map, so re-derive a best-effort one from the source content. This is
        // aligned to the player's paragraph split (unlike the old positional
        // reconstruction) and self-heals as those rows are regenerated.
        const paragraphMap =
          narrationRecord.paragraphMap ??
          buildAlignedNarration(
            htmlToNarrationInput(sourceContent).paragraphs.map((p) => ({ o: p.id, text: p.text }))
          ).paragraphMap;
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
      if (!input.useLlmNormalization || !isGroqAvailable(userGroqApiKey) || !canRetryLLM) {
        // Generate a fallback (plain-text) narration with a paragraph map aligned
        // to the player's paragraph split.
        const { narrationText: fallbackText, paragraphMap } = buildAlignedNarration(
          htmlToNarrationInput(sourceContent).paragraphs.map((p) => ({ o: p.id, text: p.text }))
        );
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
        const result = await generateNarration(sourceContent, userGroqApiKey);

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

        // Cache in narration_content table, clear any previous error.
        // Persist the paragraph map so future cache hits return the exact
        // alignment produced here instead of reconstructing it.
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

        // Fall back to plain text with a paragraph map aligned to the split
        const { narrationText: fallbackText, paragraphMap } = buildAlignedNarration(
          htmlToNarrationInput(sourceContent).paragraphs.map((p) => ({ o: p.id, text: p.text }))
        );
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
   * Returns true if either the user has configured a Groq API key
   * or the server has GROQ_API_KEY configured.
   */
  isAiTextProcessingAvailable: protectedProcedure
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
    .query(({ ctx }) => {
      return { available: ctx.session.hasGroqApiKey || !!process.env.GROQ_API_KEY };
    }),
});
