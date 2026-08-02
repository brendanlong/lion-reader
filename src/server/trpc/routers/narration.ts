/**
 * Narration Router
 *
 * Handles narration generation for entries and saved articles.
 * Uses LLM preprocessing to convert article content to TTS-ready text.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import { createTRPCRouter, confirmedProtectedProcedure as protectedProcedure } from "../trpc";
import { uuidSchema } from "../validation";
import { narrationContent } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getOwnedEntryContent } from "@/server/services/entries";
import {
  generateNarration,
  htmlToNarrationInput,
  isNarrationLlmAvailable,
  getNarrationModelRef,
} from "@/server/services/narration";
import { listAllModels } from "@/server/services/ai-providers";
import { AI_PROVIDERS, formatModelRef } from "@/lib/ai/model-ref";
import { NARRATION_FORMAT_VERSION, NARRATION_PROVIDERS } from "@/lib/narration/constants";
import { buildAlignedNarration } from "@/lib/narration/paragraph-map";
import { selectDisplayedContent } from "@/lib/narration/select-content";
import { getUserApiKeys } from "@/server/auth/session";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
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
  /**
   * Which content variant the client is displaying, so narration reads (and
   * highlights against) exactly what's on screen. Default false/false =
   * cleaned feed content.
   */
  showFullContent: z.boolean().optional().default(false),
  showOriginal: z.boolean().optional().default(false),
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
      const userNarrationModel = ctx.session.user.narrationModel;

      // Fetch API keys from DB on demand (not cached in session for security)
      const keys = await getUserApiKeys(userId);

      // Fetch the entry with the same visibility rule the entry list applies.
      // Both regular entries and saved articles are in the entries table now.
      const entry = await getOwnedEntryContent(ctx.db, userId, input.id);

      // Narrate exactly what the user is looking at: the variant the renderer
      // picks (same selector), sanitized the way the read path sanitizes it.
      // Sanitization is read-path-only, so the raw columns hold markup the page
      // never shows — a `<style>` block narration would otherwise read aloud,
      // and a lazy-loading `<noscript><img>` whose element the client never
      // numbers, which would shift every paragraph after it onto the wrong one.
      const sourceContent =
        (await sanitizeEntryHtmlAsync(
          selectDisplayedContent(entry, {
            showFullContent: input.showFullContent,
            showOriginal: input.showOriginal,
          })
        )) ?? "";
      // Key the cache by the exact content being narrated (so variants of one
      // entry don't collide) and by the narration format: a stored paragraph
      // map's element numbers only mean anything against the numbering that
      // produced them, so a format bump has to miss rather than mis-highlight.
      // In the key rather than a column so the release that wrote a row and the
      // release that reads it can never disagree — a rollback simply looks
      // somewhere else instead of overwriting a row it will misread later.
      const contentHash = createHash("sha256")
        .update(`${NARRATION_FORMAT_VERSION}\n${sourceContent}`, "utf8")
        .digest("hex");

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

      // Return cached narration if available — with the map persisted at
      // generation time, which is the only one guaranteed to align with this
      // exact text. A row with no stored map predates that column and its
      // numbering is a format older than the cache key, so it regenerates.
      if (narrationRecord.contentNarration && narrationRecord.paragraphMap) {
        trackNarrationGenerated(true, "llm");
        return {
          narration: narrationRecord.contentNarration,
          cached: true,
          source: "llm" as const,
          paragraphMap: narrationRecord.paragraphMap,
        };
      }

      // Check if we should retry after a previous error
      const canRetryLLM =
        !narrationRecord.errorAt || Date.now() - narrationRecord.errorAt.getTime() > RETRY_AFTER_MS;

      // If user disabled LLM normalization, no provider is configured, or we had a recent error, fall back to plain text
      if (
        !input.useLlmNormalization ||
        !isNarrationLlmAvailable(keys, userNarrationModel) ||
        !canRetryLLM
      ) {
        // Generate a fallback (plain-text) narration with a paragraph map aligned
        // to the player's paragraph split.
        const { narrationText: fallbackText, paragraphMap } = buildAlignedNarration(
          htmlToNarrationInput(sourceContent).paragraphs.map((p) => ({ o: p.o, text: p.text }))
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
        const result = await generateNarration(sourceContent, {
          keys,
          userModel: userNarrationModel,
        });

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
          htmlToNarrationInput(sourceContent).paragraphs.map((p) => ({ o: p.o, text: p.text }))
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
   * Returns true if the configured narration model's provider (Groq or
   * Cerebras) has a user-configured or server-configured API key.
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
      // The session only carries has-key booleans (never the keys); the
      // placeholder values below are only tested for truthiness.
      const sessionKeys = {
        groqApiKey: ctx.session.hasGroqApiKey ? "configured" : null,
        cerebrasApiKey: ctx.session.hasCerebrasApiKey ? "configured" : null,
      };
      return {
        available: isNarrationLlmAvailable(sessionKeys, ctx.session.user.narrationModel),
      };
    }),

  /**
   * List available models for narration preprocessing.
   *
   * Narration requires JSON-object responses, so only the OpenAI-compatible
   * providers (Groq, Cerebras) are listed. Providers with no key are skipped.
   */
  listModels: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/narration/models",
        tags: ["Narration"],
        summary: "List available models for narration preprocessing",
      },
    })
    .input(z.void())
    .output(
      z.object({
        models: z.array(
          z.object({
            id: z.string(),
            displayName: z.string(),
            provider: z.enum(AI_PROVIDERS),
          })
        ),
        defaultModelId: z.string(),
      })
    )
    .query(async ({ ctx }) => {
      // Fetch API keys from DB on demand (not cached in session for security)
      const keys = await getUserApiKeys(ctx.session.user.id);
      const models = await listAllModels(keys, NARRATION_PROVIDERS);
      const defaultRef = getNarrationModelRef(null, keys);
      return { models, defaultModelId: formatModelRef(defaultRef.provider, defaultRef.model) };
    }),
});
