/**
 * Narration Router
 *
 * Handles narration generation for entries and saved articles.
 * Uses LLM preprocessing to convert article content to TTS-ready text.
 */

import { z } from "zod";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  expensiveConfirmedProtectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { aiModelListSchema, uuidSchema } from "../validation";
import {
  getEntryNarration,
  getNarrationModelRef,
  isNarrationLlmAvailable,
} from "@/server/services/narration";
import { isModelAllowed, listAllModels } from "@/server/services/ai-providers";
import { formatModelRef } from "@/lib/ai/model-ref";
import { aiProviderName, SPEECH_PROVIDERS } from "@/lib/ai/providers";
import { NARRATION_PROVIDERS } from "@/lib/narration/constants";
import { defaultSpeechModelId, defaultVoiceFor, listSpeechModels } from "@/server/services/speech";
import { getUserApiKeys, getUserKeyAvailability } from "@/server/services/user-api-keys";
import { OAUTH_SCOPES } from "@/server/oauth/utils";

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
   * @param id - The entry ID
   * @returns Narration text, whether it was cached, and the source (llm or fallback)
   * @see getEntryNarration
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
    .mutation(({ ctx, input }) => getEntryNarration(ctx.db, ctx.session.user, input)),

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
      const keys = await getUserKeyAvailability(ctx.session.user.id);
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
      // Fetch API keys from DB on demand (not loaded with the session user)
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
