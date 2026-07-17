/**
 * Summarization Router
 *
 * Handles AI-powered article summarization.
 * Uses the user's configured AI provider (Anthropic, Groq, or Cerebras).
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  expensiveConfirmedProtectedProcedure,
} from "../trpc";
import { errors } from "../errors";
import { uuidSchema } from "../validation";
import { entries, entrySummaries, userEntries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import {
  generateSummary,
  isSummarizationAvailable,
  prepareContentForSummarization,
  CURRENT_PROMPT_VERSION,
  getSummarizationModelId,
  getMaxWords,
  hashPrompt,
  DEFAULT_SUMMARIZATION_PROMPT,
} from "@/server/services/summarization";
import { getAvailableProviders, listAllModels } from "@/server/services/ai-providers";
import { AI_PROVIDERS, normalizeModelRef } from "@/lib/ai/model-ref";
import { getUserApiKeys } from "@/server/auth/session";
import { logger } from "@/lib/logger";
import { sanitizeEntryHtml } from "@/server/html/sanitize";

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
  // Rate-limited (10 burst, 1/sec): makes an outbound LLM call, potentially on
  // the server-wide API key, and explicit regenerate bypasses the error
  // backoff below.
  generate: expensiveConfirmedProtectedProcedure
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
      const userSummarizationModel = ctx.session.user.summarizationModel;
      const userMaxWords = ctx.session.user.summarizationMaxWords;
      const userPrompt = ctx.session.user.summarizationPrompt;

      // Fetch API keys from DB on demand (not cached in session for security)
      const keys = await getUserApiKeys(userId);

      const currentModelId = getSummarizationModelId(userSummarizationModel, keys);
      const currentMaxWords = getMaxWords(userMaxWords);
      const currentPromptHash = hashPrompt(userPrompt);

      /**
       * Whether the settings used to generate a cached summary differ from the
       * user's current settings. `maxWords`/`promptHash` are only compared when
       * present so summaries cached before these columns existed (null) aren't
       * reported as stale. See #824.
       */
      const isSettingsChanged = (record: {
        promptVersion: number;
        modelId: string | null;
        maxWords: number | null;
        promptHash: string | null;
      }): boolean => {
        const promptVersionChanged = record.promptVersion !== CURRENT_PROMPT_VERSION;
        // Compare as normalized provider:model refs so summaries cached under
        // a legacy bare Anthropic ID (e.g. "claude-sonnet-5") aren't reported
        // stale against the same model's new prefixed form.
        const modelChanged =
          record.modelId !== null &&
          normalizeModelRef(record.modelId) !== normalizeModelRef(currentModelId);
        const maxWordsChanged = record.maxWords !== null && record.maxWords !== currentMaxWords;
        const promptChanged = record.promptHash !== null && record.promptHash !== currentPromptHash;
        return promptVersionChanged || modelChanged || maxWordsChanged || promptChanged;
      };

      // Check if summarization is available (user key or server key, any provider)
      if (!isSummarizationAvailable(keys)) {
        throw errors.internal(
          "AI summarization is not configured. Add an Anthropic, Groq, or Cerebras API key in Settings to enable it."
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
            return {
              // Sanitize on read with the *current* rules. Cached summaries are
              // stored already-sanitized, but re-sanitizing here means a
              // SANITIZER_VERSION bump (e.g. one that closes a sanitizer hole) is
              // applied to every stored summary without a version column or
              // migration — unlike large entry bodies, summaries are small enough
              // that re-sanitizing on each read is cheaper than tracking staleness.
              summary: sanitizeEntryHtml(fullRecord.summaryText) ?? "",
              cached: true,
              modelId: fullRecord.modelId || "unknown",
              generatedAt: fullRecord.generatedAt,
              settingsChanged: isSettingsChanged(fullRecord),
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
          return {
            summary: sanitizeEntryHtml(feedRecord.summaryText) ?? "",
            cached: true,
            modelId: feedRecord.modelId || "unknown",
            generatedAt: feedRecord.generatedAt,
            settingsChanged: isSettingsChanged(feedRecord),
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

      // Check if settings have changed since this summary was generated.
      // promptVersionChanged also gates cache reuse below (a built-in prompt
      // bump invalidates the cache), so it stays a separate variable.
      const promptVersionChanged = summaryRecord.promptVersion !== CURRENT_PROMPT_VERSION;
      const settingsChanged = isSettingsChanged(summaryRecord);

      // Return cached summary if available and not stale (prompt version unchanged),
      // unless the user explicitly requested regeneration
      if (summaryRecord.summaryText && !promptVersionChanged && !input.regenerate) {
        return {
          summary: sanitizeEntryHtml(summaryRecord.summaryText) ?? "",
          cached: true,
          modelId: summaryRecord.modelId || "unknown",
          generatedAt: summaryRecord.generatedAt,
          settingsChanged,
        };
      }

      // Check if we should retry after a previous error. The backoff guards
      // against automatic retry loops; an explicit user retry (the error
      // card's "Try again" / the regenerate button both send regenerate:
      // true) always goes through — e.g. after the user fixes the failure by
      // changing model or keys.
      const canRetry =
        input.regenerate ||
        !summaryRecord.errorAt ||
        Date.now() - summaryRecord.errorAt.getTime() > RETRY_AFTER_MS;

      if (!canRetry) {
        // Note this echoes the stored error from the *previous* attempt — no
        // new request was made (the settings may have changed since).
        throw errors.internal(
          `Summarization failed recently and this request was not retried. Use Regenerate to retry now, or try again later. Previous error: ${summaryRecord.error}`
        );
      }

      try {
        // Prepare content for summarization (convert to plain text, truncate if needed)
        const preparedContent = prepareContentForSummarization(sourceContent);

        // Generate via LLM
        const result = await generateSummary(preparedContent, entry.title ?? "", {
          keys,
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
            maxWords: currentMaxWords,
            promptHash: currentPromptHash,
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
   * Returns true if any provider (Anthropic, Groq, Cerebras) has a
   * user-configured or server-configured API key.
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
      const available =
        ctx.session.hasAnthropicApiKey ||
        ctx.session.hasGroqApiKey ||
        ctx.session.hasCerebrasApiKey ||
        getAvailableProviders().length > 0;
      return { available };
    }),

  /**
   * List available models for summarization across all configured providers.
   *
   * Uses the user's API keys where configured, otherwise falls back to the
   * server keys. Providers with no key are skipped; returns an empty array if
   * none is available.
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
            provider: z.enum(AI_PROVIDERS),
          })
        ),
        defaultModelId: z.string(),
      })
    )
    .query(async ({ ctx }) => {
      // Fetch API keys from DB on demand (not cached in session for security)
      const keys = await getUserApiKeys(ctx.session.user.id);
      const models = await listAllModels(keys);
      return { models, defaultModelId: getSummarizationModelId(null, keys) };
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
