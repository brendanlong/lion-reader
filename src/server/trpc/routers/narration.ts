/**
 * Narration Router
 *
 * Handles narration generation for entries and saved articles.
 * Uses LLM preprocessing to convert article content to TTS-ready text.
 */

import { z } from "zod";
import { eq } from "drizzle-orm";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  expensiveConfirmedProtectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { errors } from "../errors";
import { aiModelListSchema, uuidSchema } from "../validation";
import { narrationContent } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getOwnedEntryRawContent } from "@/server/services/entries";
import {
  buildFallbackNarration,
  generateNarration,
  isNarrationLlmAvailable,
  getNarrationModelRef,
  narrationCacheOwner,
  narrationContentHash,
  narrationFailureScope,
  type NarrationFailure,
} from "@/server/services/narration";
import { htmlToNarrationInput } from "@/lib/narration/html-to-narration-input";
import { isModelAllowed, isTextModelAllowed, listAllModels } from "@/server/services/ai-providers";
import { formatModelRef } from "@/lib/ai/model-ref";
import { aiProviderName, SPEECH_PROVIDERS } from "@/lib/ai/providers";
import { NARRATION_PROVIDERS } from "@/lib/narration/constants";
import { defaultSpeechModelId, defaultVoiceFor, listSpeechModels } from "@/server/services/speech";
import { selectDisplayedContent } from "@/lib/narration/select-content";
import { getApiKeyProviders, getUserApiKeys } from "@/server/auth/session";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
import { logger } from "@/lib/logger";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
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
  // Rate-limited: a cache miss makes an outbound LLM call, potentially on the
  // server-wide API key.
  generate: expensiveConfirmedProtectedProcedure
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
      const entry = await getOwnedEntryRawContent(ctx.db, userId, input.id);

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

      // The model this request narrates with, resolved once: the cache slot
      // it reads (see narrationContentHash) and the call that fills it must
      // agree on whose output it is.
      const modelRef = await getNarrationModelRef(userNarrationModel, keys);
      const contentHash = narrationContentHash(
        sourceContent,
        narrationCacheOwner(modelRef, userId)
      );

      const selectByContentHash = () =>
        ctx.db
          .select()
          .from(narrationContent)
          .where(eq(narrationContent.contentHash, contentHash))
          .limit(1);

      // Look up existing narration by content hash
      let narrationRecord = (await selectByContentHash())[0];

      // Create the placeholder row if there isn't one yet. `content_hash` is
      // *globally* unique (the cache is deduplicated across users), so two
      // users narrating the same article at once both miss the SELECT above and
      // race here; let the constraint arbitrate and re-read the winner's row
      // rather than surfacing a raw unique-violation 500.
      if (!narrationRecord) {
        const inserted = await ctx.db
          .insert(narrationContent)
          .values({
            id: generateUuidv7(),
            contentHash,
            createdAt: new Date(),
          })
          .onConflictDoNothing({ target: narrationContent.contentHash })
          .returning();
        narrationRecord = inserted[0] ?? (await selectByContentHash())[0];
      }

      if (!narrationRecord) {
        // Only reachable if the conflicting row was deleted between the insert
        // and the re-read; nothing useful to narrate against, so surface it.
        throw errors.internal("Failed to create narration record");
      }

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

      // Plain-text narration with a paragraph map aligned to the player's split.
      const fallbackResponse = (
        result = buildFallbackNarration(htmlToNarrationInput(sourceContent).paragraphs)
      ) => {
        trackNarrationGenerated(false, "fallback");
        return {
          narration: result.text,
          cached: false,
          source: "fallback" as const,
          paragraphMap: result.paragraphMap,
        };
      };

      // Check if we should retry after a previous error
      const canRetryLLM =
        !narrationRecord.errorAt || Date.now() - narrationRecord.errorAt.getTime() > RETRY_AFTER_MS;

      // If user disabled LLM normalization, no provider is configured, or we had a recent error, fall back to plain text
      if (
        !input.useLlmNormalization ||
        !(await isTextModelAllowed(formatModelRef(modelRef.provider, modelRef.model), keys)) ||
        !canRetryLLM
      ) {
        return fallbackResponse();
      }

      // Start timer for LLM generation duration
      const stopTimer = startNarrationGenerationTimer();

      // Record a failure the content caused so replays within RETRY_AFTER_MS
      // serve the plain-text fallback instead of paying for another LLM call.
      // The row is everyone's, so nothing else is recorded on it.
      const recordId = narrationRecord.id;
      const recordFailure = async (failure: NarrationFailure, message: string) => {
        if (narrationFailureScope(failure) !== "content") return;
        await ctx.db
          .update(narrationContent)
          .set({ error: message, errorAt: new Date() })
          .where(eq(narrationContent.id, recordId));
      };

      try {
        // Generate via LLM
        const result = await generateNarration(sourceContent, { keys, modelRef });

        // Stop the timer after generation completes
        stopTimer();

        // The LLM answered but its output was empty or unusable: don't cache the
        // fallback as narration, but back off — the tokens were billed, and
        // the same input would likely fail again.
        if (result.source === "fallback") {
          trackNarrationGenerationError("empty_response");
          if (result.failure) {
            await recordFailure(result.failure, "LLM returned empty or unparseable output");
          }
          return fallbackResponse(result);
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

        await recordFailure(
          { kind: "error", error },
          error instanceof Error ? error.message : "Unknown error"
        );

        return fallbackResponse();
      }
    }),

  /**
   * Check if AI text processing is available.
   *
   * Returns true if the configured narration model's provider has a
   * user-configured or server-configured API key.
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
    .query(async ({ ctx }) => {
      // Availability only needs to know which keys exist, not decrypt them.
      const providers = await getApiKeyProviders(ctx.session.user.id);
      const keys = Object.fromEntries(providers.map((provider) => [provider, "configured"]));
      return { available: await isNarrationLlmAvailable(keys, ctx.session.user.narrationModel) };
    }),

  /**
   * List available models for narration preprocessing.
   *
   * Narration requires JSON-object responses, so only the OpenAI-compatible
   * providers are listed, and only models that support JSON mode. Providers
   * with no key are skipped.
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
    .output(aiModelListSchema)
    .query(async ({ ctx }) => {
      // Fetch API keys from DB on demand (not cached in session for security)
      const keys = await getUserApiKeys(ctx.session.user.id);
      const models = (await listAllModels(keys, NARRATION_PROVIDERS, { jsonObject: true })).filter(
        (model) => isModelAllowed(model.id, keys, model)
      );
      const defaultRef = await getNarrationModelRef(null, keys);
      return { models, defaultModelId: formatModelRef(defaultRef.provider, defaultRef.model) };
    }),

  /**
   * List speech models for cloud voices, across the providers with a key (user
   * or server). Empty when there's none, which is also how the client tells
   * whether cloud voices are available. Given the model and voice the user
   * picked, that voice is listed while the provider still has it, even if the
   * provider's list of voices to offer has moved on.
   */
  listVoiceModels: scopedProtectedProcedure(OAUTH_SCOPES.READER_FULL_ACCESS)
    .meta({
      openapi: {
        method: "GET",
        path: "/narration/voice-models",
        tags: ["Narration"],
        summary: "List speech models for cloud voices",
      },
    })
    .input(
      z
        .object({
          /** `provider:model` ref of the user's pick. */
          model: z.string().max(200).optional(),
          voice: z.string().max(200).optional(),
        })
        .optional()
    )
    .output(
      z.object({
        models: z.array(
          z.object({
            id: z.string(),
            displayName: z.string(),
            provider: z.enum(SPEECH_PROVIDERS),
            providerDisplayName: z.string(),
            /** `id` is what speech requests take; `name` is for showing. */
            voices: z.array(z.object({ id: z.string(), name: z.string() })),
            defaultVoice: z.string(),
            pricePerMillionCharacters: z.number().optional(),
          })
        ),
        defaultModelId: z.string(),
      })
    )
    .query(async ({ ctx, input }) => {
      const keys = await getUserApiKeys(ctx.session.user.id);
      const { models: speechModels } = await listSpeechModels(keys, {
        model: input?.model ?? null,
        voice: input?.voice ?? null,
        userId: ctx.session.user.id,
      });
      const models = speechModels.map((model) => ({
        ...model,
        providerDisplayName: aiProviderName(model.provider),
        defaultVoice: defaultVoiceFor(model),
      }));
      return { models, defaultModelId: defaultSpeechModelId(speechModels) };
    }),
});
