/**
 * Summarization Router
 *
 * Handles AI-powered article summarization, on any text provider in the
 * registry (`@/lib/ai/providers`) the user or server has a key for.
 */

import { z } from "zod";
import { eq, and } from "drizzle-orm";

import {
  createTRPCRouter,
  confirmedProtectedProcedure as protectedProcedure,
  expensiveScopedProtectedProcedure,
  scopedProtectedProcedure,
} from "../trpc";
import { errors } from "../errors";
import { aiModelListSchema, uuidSchema } from "../validation";
import { entrySummaries } from "@/server/db/schema";
import { generateUuidv7 } from "@/lib/uuidv7";
import { getOwnedEntryRawContent } from "@/server/services/entries";
import {
  generateSummary,
  isSummarizationAvailable,
  prepareContentForSummarization,
  CURRENT_PROMPT_VERSION,
  getSummarizationModelId,
  getMaxWords,
  hashPrompt,
  DEFAULT_SUMMARIZATION_PROMPT,
  sanitizeSummaryHtml,
} from "@/server/services/summarization";
import { isModelAllowed, listAllModels, TextGenerationError } from "@/server/services/ai-providers";
import { normalizeModelRef } from "@/lib/ai/model-ref";
import { getApiKeyProviders, getUserApiKeys } from "@/server/auth/session";
import { aiProviderName } from "@/lib/ai/providers";
import { logger } from "@/lib/logger";
import { OAUTH_SCOPES } from "@/server/oauth/utils";
import type { TRPCError } from "@trpc/server";

// ============================================================================
// Constants
// ============================================================================

/**
 * Time to wait before retrying after an error (1 hour in milliseconds).
 */
const RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * The error to answer a failed generation with, and whether it's worth
 * recording as the backoff. A busy provider isn't: the next tap should simply
 * try again. The provider's own message is shown only when the user's key made
 * the call — on the server's key it may describe the operator's account, so it
 * stays in the logs.
 */
function summaryFailure(error: unknown): { error: TRPCError; backoff: boolean } {
  if (!(error instanceof TextGenerationError)) {
    // Our own (e.g. no key configured, an empty response).
    const message = error instanceof Error ? error.message : "Unknown error";
    return { error: errors.internal(`Failed to generate summary: ${message}`), backoff: true };
  }
  const provider = aiProviderName(error.provider);
  if (error.failure === "busy") {
    return { error: errors.aiProviderBusy(provider), backoff: false };
  }
  if (!error.usedUserKey) {
    return {
      error: errors.internal("Failed to generate summary. Please try again later."),
      backoff: true,
    };
  }
  return {
    error:
      error.failure === "rejected"
        ? errors.aiProviderRejected(provider, error.message)
        : errors.internal(`Failed to generate summary: ${error.message}`),
    backoff: true,
  };
}

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
  // backoff below. The native app may call it (and `isAvailable`); model and
  // prompt settings stay session-only.
  generate: expensiveScopedProtectedProcedure(OAUTH_SCOPES.READER_FULL_ACCESS)
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

      const currentModelId = await getSummarizationModelId(userSummarizationModel, keys);
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

      const selectSummary = async (hash: string) =>
        (
          await ctx.db
            .select()
            .from(entrySummaries)
            .where(and(eq(entrySummaries.userId, userId), eq(entrySummaries.contentHash, hash)))
            .limit(1)
        )[0];

      const toCachedResult = (
        record: typeof entrySummaries.$inferSelect,
        settingsChanged: boolean
      ) => ({
        // Sanitize on read with the *current* rules. Cached summaries are
        // stored already-sanitized, but re-sanitizing here means a rules
        // change (e.g. one that closes a sanitizer hole) reaches every
        // stored summary on the next read, with no version column or
        // migration — unlike large entry bodies, summaries are small enough
        // that re-sanitizing on each read is cheaper than tracking staleness.
        summary: record.summaryText ? sanitizeSummaryHtml(record.summaryText) : "",
        cached: true,
        modelId: record.modelId || "unknown",
        generatedAt: record.generatedAt,
        settingsChanged,
      });

      // Check if summarization is available (user key or server key, any provider)
      if (!(await isSummarizationAvailable(keys, userSummarizationModel))) {
        throw errors.internal(
          "AI summarization is not configured. Add an AI provider API key in Settings to enable it."
        );
      }

      // Fetch the entry with the same visibility rule the entry list applies
      const entry = await getOwnedEntryRawContent(ctx.db, userId, input.entryId);

      // Determine which content version and hash to use based on useFullContent param:
      // - true: use full content (error if not available)
      // - false: use feed content only
      // - undefined: return any cached summary, or generate from feed content
      let sourceContent: string;
      let contentHash: string;
      /**
       * The `(userId, contentHash)` row the `undefined` branch already looked
       * up, carried forward so the generation path below doesn't re-run the
       * byte-identical query.
       */
      let cachedFeedSummary: { record: typeof entrySummaries.$inferSelect | undefined } | undefined;

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
        // undefined: try to return whichever cached summary exists, preferring
        // full content. `regenerate` means the caller explicitly asked to skip
        // the cache, so don't serve (or even look up) a stored summary here —
        // fall through to generating from feed content.
        // Check full content summary first (if available)
        if (!input.regenerate && entry.fullContentHash) {
          const fullRecord = await selectSummary(entry.fullContentHash);
          if (fullRecord?.summaryText) {
            return toCachedResult(fullRecord, isSettingsChanged(fullRecord));
          }
        }

        // Check feed content summary
        const feedRecord = await selectSummary(entry.contentHash);
        if (!input.regenerate && feedRecord?.summaryText) {
          return toCachedResult(feedRecord, isSettingsChanged(feedRecord));
        }

        // No usable cached summary — generate from feed content
        sourceContent = entry.contentCleaned || entry.contentOriginal || "";
        contentHash = entry.contentHash;
        cachedFeedSummary = { record: feedRecord };
      }

      // Handle empty content
      if (!sourceContent.trim()) {
        throw errors.validation("Entry has no content to summarize");
      }

      // Look up existing summary by user + content hash
      let summaryRecord = cachedFeedSummary
        ? cachedFeedSummary.record
        : await selectSummary(contentHash);

      // Create the placeholder row if there isn't one yet. Two requests for the
      // same (user, content) at once — a double-click, or the web client and
      // MCP together — both miss the SELECT above and race here, so let the
      // `(user_id, content_hash)` unique constraint arbitrate and re-read the
      // winner's row rather than surfacing a raw unique-violation 500.
      if (!summaryRecord) {
        const inserted = await ctx.db
          .insert(entrySummaries)
          .values({
            id: generateUuidv7(),
            userId,
            contentHash,
            promptVersion: CURRENT_PROMPT_VERSION,
            createdAt: new Date(),
          })
          .onConflictDoNothing({
            target: [entrySummaries.userId, entrySummaries.contentHash],
          })
          .returning();
        summaryRecord = inserted[0] ?? (await selectSummary(contentHash));
      }

      if (!summaryRecord) {
        // Only reachable if the conflicting row was deleted between the insert
        // and the re-read; there is nothing to record the generation against.
        throw errors.internal("Failed to create summary record");
      }

      // Check if settings have changed since this summary was generated.
      // promptVersionChanged also gates cache reuse below (a built-in prompt
      // bump invalidates the cache), so it stays a separate variable.
      const promptVersionChanged = summaryRecord.promptVersion !== CURRENT_PROMPT_VERSION;
      const settingsChanged = isSettingsChanged(summaryRecord);

      // Return cached summary if available and not stale (prompt version unchanged),
      // unless the user explicitly requested regeneration
      if (summaryRecord.summaryText && !promptVersionChanged && !input.regenerate) {
        return toCachedResult(summaryRecord, settingsChanged);
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
        throw errors.summaryRecentlyFailed(summaryRecord.error ?? "unknown error");
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
        logger.error("Summary generation failed", {
          contentHash,
          error: error instanceof Error ? error.message : String(error),
        });

        const failure = summaryFailure(error);
        if (failure.backoff) {
          // What the user was told, not the raw error: this is echoed back by
          // the backoff above.
          await ctx.db
            .update(entrySummaries)
            .set({ error: failure.error.message, errorAt: new Date() })
            .where(eq(entrySummaries.id, summaryRecord.id));
        }
        throw failure.error;
      }
    }),

  /**
   * Check if AI summarization is available.
   *
   * Returns true if any text provider has a user-configured or
   * server-configured API key.
   */
  isAvailable: scopedProtectedProcedure(OAUTH_SCOPES.READER_FULL_ACCESS)
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
    .query(async ({ ctx }) => {
      // Availability only needs to know which keys exist, not decrypt them.
      const providers = await getApiKeyProviders(ctx.session.user.id);
      const keys = Object.fromEntries(providers.map((provider) => [provider, "configured"]));
      return {
        available: await isSummarizationAvailable(keys, ctx.session.user.summarizationModel),
      };
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
    .output(aiModelListSchema)
    .query(async ({ ctx }) => {
      // Fetch API keys from DB on demand (not cached in session for security)
      const keys = await getUserApiKeys(ctx.session.user.id);
      const models = (await listAllModels(keys)).filter((model) =>
        isModelAllowed(model.id, keys, model)
      );
      return { models, defaultModelId: await getSummarizationModelId(null, keys) };
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
