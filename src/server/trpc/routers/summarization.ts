/**
 * Summarization Router
 *
 * Handles AI-powered article summarization.
 * Uses Anthropic Claude for generating concise summaries.
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import { createTRPCRouter, protectedProcedure } from "../trpc";
import { errors } from "../errors";
import { entries, entrySummaries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateSummary,
  isSummarizationAvailable,
  prepareContentForSummarization,
  CURRENT_PROMPT_VERSION,
  getSummarizationModelId,
  listModels,
  DEFAULT_SUMMARIZATION_PROMPT,
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
  /**
   * Controls which content version to summarize:
   * - `true`: Summarize full content (error if not fetched yet)
   * - `false`: Summarize feed content only
   * - `undefined`/omitted: Return cached summary if available, otherwise summarize feed content
   */
  useFullContent: z.boolean().optional(),
  /**
   * When true, skip the cache and regenerate the summary even if one exists.
   * Used when the user explicitly clicks "Regenerate" (e.g., after changing model/settings).
   */
  regenerate: z.boolean().optional(),
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
  /** True if current settings differ from what was used to generate this summary */
  settingsChanged: z.boolean(),
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
      const userAnthropicApiKey = ctx.session.user.anthropicApiKey;
      const userSummarizationModel = ctx.session.user.summarizationModel;
      const userMaxWords = ctx.session.user.summarizationMaxWords;
      const userPrompt = ctx.session.user.summarizationPrompt;

      // Check if summarization is available (user key or server key)
      if (!isSummarizationAvailable(userAnthropicApiKey)) {
        throw errors.internal(
          "AI summarization is not configured. Add an Anthropic API key in Settings to enable it."
        );
      }

      // Fetch the entry with visibility check via user_entries join
      const entryResult = await ctx.db
        .select({
          id: entries.id,
          contentCleaned: entries.contentCleaned,
          contentOriginal: entries.contentOriginal,
          contentHash: entries.contentHash,
          fullContentCleaned: entries.fullContentCleaned,
          fullContentHash: entries.fullContentHash,
          title: entries.title,
        })
        .from(entries)
        .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
        .where(and(eq(entries.id, input.entryId), eq(userEntries.userId, userId)))
        .limit(1);

      if (entryResult.length === 0) {
        throw errors.entryNotFound();
      }

      const entry = entryResult[0];

      // Determine which content version and hash to use based on useFullContent param:
      // - true: use full content (error if not available)
      // - false: use feed content only
      // - undefined: return any cached summary, or generate from feed content
      let sourceContent: string;
      let contentHash: string;

      if (input.useFullContent === true) {
        // Explicit full content request
        if (!entry.fullContentCleaned) {
          throw errors.validation("Full content has not been fetched for this entry");
        }
        if (!entry.fullContentHash) {
          throw errors.validation("Full content hash is not available for this entry");
        }
        sourceContent = entry.fullContentCleaned;
        contentHash = entry.fullContentHash;
      } else if (input.useFullContent === false) {
        // Explicit feed content request
        sourceContent = entry.contentCleaned || entry.contentOriginal || "";
        contentHash = entry.contentHash;
      } else {
        // undefined: try to return whichever cached summary exists, preferring full content
        // Check full content summary first (if available)
        if (entry.fullContentHash) {
          const fullSummary = await ctx.db
            .select()
            .from(entrySummaries)
            .where(
              and(
                eq(entrySummaries.userId, userId),
                eq(entrySummaries.contentHash, entry.fullContentHash)
              )
            )
            .limit(1);

          const fullRecord = fullSummary[0];
          if (fullRecord?.summaryText) {
            const currentModelId = getSummarizationModelId(userSummarizationModel);
            const promptVersionChanged = fullRecord.promptVersion !== CURRENT_PROMPT_VERSION;
            const modelChanged =
              fullRecord.modelId !== null && fullRecord.modelId !== currentModelId;
            return {
              summary: fullRecord.summaryText,
              cached: true,
              modelId: fullRecord.modelId || "unknown",
              generatedAt: fullRecord.generatedAt,
              settingsChanged: promptVersionChanged || modelChanged,
            };
          }
        }

        // Check feed content summary
        const feedSummary = await ctx.db
          .select()
          .from(entrySummaries)
          .where(
            and(
              eq(entrySummaries.userId, userId),
              eq(entrySummaries.contentHash, entry.contentHash)
            )
          )
          .limit(1);

        const feedRecord = feedSummary[0];
        if (feedRecord?.summaryText) {
          const currentModelId = getSummarizationModelId(userSummarizationModel);
          const promptVersionChanged = feedRecord.promptVersion !== CURRENT_PROMPT_VERSION;
          const modelChanged = feedRecord.modelId !== null && feedRecord.modelId !== currentModelId;
          return {
            summary: feedRecord.summaryText,
            cached: true,
            modelId: feedRecord.modelId || "unknown",
            generatedAt: feedRecord.generatedAt,
            settingsChanged: promptVersionChanged || modelChanged,
          };
        }

        // No cached summary found — generate from feed content
        sourceContent = entry.contentCleaned || entry.contentOriginal || "";
        contentHash = entry.contentHash;
      }

      // Handle empty content
      if (!sourceContent.trim()) {
        throw errors.validation("Entry has no content to summarize");
      }

      // Look up existing summary by user + content hash
      let summary = await ctx.db
        .select()
        .from(entrySummaries)
        .where(and(eq(entrySummaries.userId, userId), eq(entrySummaries.contentHash, contentHash)))
        .limit(1);

      // Create placeholder record if not found
      if (summary.length === 0) {
        const newId = generateUuidv7();
        await ctx.db.insert(entrySummaries).values({
          id: newId,
          userId,
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

      // Check if settings have changed since this summary was generated
      const currentModelId = getSummarizationModelId(userSummarizationModel);
      const promptVersionChanged = summaryRecord.promptVersion !== CURRENT_PROMPT_VERSION;
      const modelChanged =
        summaryRecord.modelId !== null && summaryRecord.modelId !== currentModelId;
      const settingsChanged = promptVersionChanged || modelChanged;

      // Return cached summary if available and not stale (prompt version unchanged),
      // unless the user explicitly requested regeneration
      if (summaryRecord.summaryText && !promptVersionChanged && !input.regenerate) {
        return {
          summary: summaryRecord.summaryText,
          cached: true,
          modelId: summaryRecord.modelId || "unknown",
          generatedAt: summaryRecord.generatedAt,
          settingsChanged,
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
        const result = await generateSummary(preparedContent, entry.title ?? "", {
          userApiKey: userAnthropicApiKey,
          userModel: userSummarizationModel,
          userMaxWords: userMaxWords,
          userPrompt: userPrompt,
        });

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
          settingsChanged: false,
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
   * Returns true if either the user has configured an Anthropic API key
   * or the server has ANTHROPIC_API_KEY configured.
   */
  isAvailable: protectedProcedure
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
    .query(({ ctx }) => {
      return { available: isSummarizationAvailable(ctx.session.user.anthropicApiKey) };
    }),

  /**
   * List available Anthropic models for summarization.
   *
   * Uses the user's API key if configured, otherwise falls back to the server key.
   * Returns an empty array if no key is available.
   */
  listModels: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/summarization/models",
        tags: ["Summarization"],
        summary: "List available models for summarization",
      },
    })
    .input(z.void())
    .output(
      z.object({
        models: z.array(
          z.object({
            id: z.string(),
            displayName: z.string(),
          })
        ),
        defaultModelId: z.string(),
      })
    )
    .query(async ({ ctx }) => {
      const models = await listModels(ctx.session.user.anthropicApiKey);
      return { models, defaultModelId: getSummarizationModelId() };
    }),

  /**
   * Get the default summarization prompt template.
   *
   * Returns the built-in prompt so the frontend can display it as a placeholder
   * when the user hasn't set a custom prompt.
   */
  defaultPrompt: protectedProcedure
    .meta({
      openapi: {
        method: "GET",
        path: "/summarization/default-prompt",
        tags: ["Summarization"],
        summary: "Get default summarization prompt template",
      },
    })
    .input(z.void())
    .output(z.object({ prompt: z.string() }))
    .query(() => {
      return { prompt: DEFAULT_SUMMARIZATION_PROMPT };
    }),
});
