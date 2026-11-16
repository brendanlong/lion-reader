/**
 * Narration service for LLM-based text preprocessing.
 *
 * Uses a text provider from the registry (`@/lib/ai/providers`) that supports
 * JSON-object responses to convert article HTML to narration-ready text for
 * text-to-speech, cached per content in `narration_content`. Falls back to
 * plain text when the LLM can't be used.
 */

import { errors, getAppErrorCode } from "@/server/errors";
import { z } from "zod";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { generateUuidv7 } from "@/lib/uuidv7";
import type { db as dbType } from "@/server/db";
import { narrationContent } from "@/server/db/schema";
import { getOwnedEntryRawContent } from "@/server/services/entry-reads";
import { getUserApiKeys } from "@/server/services/user-api-keys";
import { sanitizeEntryHtmlAsync } from "@/server/html/sanitize";
import { selectDisplayedContent } from "@/lib/entry-content";
import {
  formatModelRef,
  normalizeModelRef,
  parseModelRef,
  type ModelRef,
} from "@/lib/ai/model-ref";
import {
  DEFAULT_NARRATION_MODELS,
  isNarrationProvider,
  NARRATION_FORMAT_VERSION,
  NARRATION_PROVIDERS,
} from "@/lib/narration/constants";
import {
  generateChatCompletion,
  isOnUserKey,
  planIncludesFeature,
  isProviderAvailable,
  isTextModelAllowed,
  TextGenerationError,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import { htmlToNarrationInput } from "@/lib/narration/html-to-narration-input";
import { spokenScripts } from "@/lib/narration/runs";
import { buildAlignedNarration, type ParagraphMapEntry } from "@/lib/narration/paragraph-map";
import type { NarrationInputParagraph } from "@/lib/narration/html-to-narration-input";
import {
  startNarrationGenerationTimer,
  trackNarrationGenerated,
  trackNarrationGenerationError,
  trackNarrationHighlightFallback,
} from "@/server/metrics/metrics";

/**
 * Schema for a single paragraph from the LLM.
 * Forgiving of id as string or number.
 */
const llmParagraphSchema = z.object({
  id: z
    .union([z.number(), z.string()])
    .transform((val) => (typeof val === "string" ? parseInt(val, 10) : val)),
  text: z
    .string()
    .nullable()
    .transform((val) => val ?? ""),
});

/**
 * Schema for the LLM's structured JSON output.
 */
const llmOutputSchema = z.object({
  paragraphs: z.array(llmParagraphSchema),
});

/**
 * System prompt for the LLM that converts article content to narration-ready text.
 */
const NARRATION_SYSTEM_PROMPT = `Convert article paragraphs to narration-ready text for text-to-speech.

Transform each paragraph to be TTS-friendly. Return the same structure with matching IDs in the same order.

CRITICAL: One input paragraph → One output paragraph. Do NOT combine or split.

RULES:
- Keep paragraph IDs exactly as provided (as numbers)
- Expand abbreviations based on context:
  - Titles before names: "Dr. Smith" → "Doctor Smith", "Mr. Jones" → "Mister Jones"
  - Units after numbers: "10 px" → "10 pixels", "5 ms" → "5 milliseconds"
  - General abbreviations: "etc." → "et cetera", "e.g." → "for example"
- Keep acronyms and product names intact - interpret based on context:
  - Standalone acronyms: "tl;dr" → "TL;DR", "api" → "API", "html" → "HTML"
  - Product versions: "iPhone 15 Pro" stays as-is, "Pixel 8" stays as-is
  - Model names that look like abbreviations: "iPhone SE" stays as-is
- Expand number suffixes ONLY when context makes the meaning unambiguous - use judgement, don't guess:
  - "6'" → "6 feet", "6\"" → "6 inches" when describing height/length; "$6B" → "6 billion dollars", "6M users" → "6 million users"; "4x faster" → "4 times faster"
  - Leave it literal when the suffix is part of a name or its meaning is unclear: "5900X" (AMD chip) stays as-is (the X is read as a letter), "Model X" stays as-is
  - If you can't tell from context what a suffix means, leave it unchanged so TTS reads it literally rather than inventing a meaning
- Superscripts and subscripts are marked <sup>…</sup> and <sub>…</sub>. Never output these tags: say what each one means
  - Footnote and citation markers become "(footnote N)": "It shipped in 2019.<sup>1</sup>" → "It shipped in 2019 (footnote 1).", "a claim [3]" → "a claim (footnote 3)"
  - Exponents and chemical formulas are read out: "10 m<sup>2</sup>" → "10 square meters", "H<sub>2</sub>O" → "H 2 O"
  - If you can't tell what one means, keep its text as it is, without the tags
- Leave other square brackets alone: "[sic]", "arr[0]"
- Write out math equations as they are spoken: "E=mc<sup>2</sup>" → "E equals m c squared", "x + y = 2" → "x plus y equals 2". Not code, URLs, dates, scores or ranges: "2024-01-02" and "won 5-3" stay as-is
- Image alt text is already speakable - clean up if needed, don't rephrase
- Skip garbage content (ellipsis, ads, junk) using empty string: "text": ""
- Keep content faithful - do NOT summarize or editorialize
- Add punctuation for natural TTS pauses

INPUT:
{
  "paragraphs": [
    { "id": 0, "text": "Title" },
    { "id": 1, "text": "Dr. Smith said hello." },
    { "id": 2, "text": "The margin is 10 px." },
    { "id": 3, "text": "tl;dr: it works great" },
    { "id": 4, "text": "The rocket is 6' tall and 4x faster." },
    { "id": 5, "text": "The Ryzen 5900X is fast." },
    { "id": 6, "text": "..." },
    { "id": 7, "text": "It shipped in 2019.<sup>2</sup> It runs on E=mc<sup>2</sup>." }
  ]
}

OUTPUT:
{
  "paragraphs": [
    { "id": 0, "text": "Title." },
    { "id": 1, "text": "Doctor Smith said hello." },
    { "id": 2, "text": "The margin is 10 pixels." },
    { "id": 3, "text": "TL;DR: it works great." },
    { "id": 4, "text": "The rocket is 6 feet tall and 4 times faster." },
    { "id": 5, "text": "The Ryzen 5900X is fast." },
    { "id": 6, "text": "" },
    { "id": 7, "text": "It shipped in 2019 (footnote 2). It runs on E equals m c squared." }
  ]
}

Return ONLY valid JSON.`;

/**
 * Resolves the narration model as a `provider:model` reference.
 * Priority: user setting > `NARRATION_MODEL` env var > the default model of
 * the first configured provider, in `NARRATION_PROVIDERS` order, each only if
 * it can be used (see `isModelAllowed`).
 *
 * Narration preprocessing requires JSON-object responses, which only the
 * OpenAI-compatible providers support — a reference that resolves to another
 * provider (e.g. a legacy bare model ID) is skipped.
 */
export async function getNarrationModelRef(
  userModel?: string | null,
  keys?: AiProviderKeys
): Promise<ModelRef> {
  for (const explicit of [userModel, process.env.NARRATION_MODEL]) {
    if (
      explicit &&
      isNarrationProvider(parseModelRef(explicit).provider) &&
      (await isTextModelAllowed(explicit, keys))
    ) {
      return parseModelRef(explicit);
    }
  }
  for (const provider of NARRATION_PROVIDERS) {
    const model = DEFAULT_NARRATION_MODELS[provider];
    if (isProviderAvailable(provider, keys) && (await isTextModelAllowed(model, keys))) {
      return parseModelRef(model);
    }
  }
  const provider = NARRATION_PROVIDERS.find((p) => isProviderAvailable(p, keys)) ?? "cerebras";
  return parseModelRef(DEFAULT_NARRATION_MODELS[provider]);
}

/**
 * Builds a fallback narration result (plain input text, no LLM) with a paragraph
 * map aligned to how the player splits paragraphs. Shared by every fallback arm
 * (LLM off/unavailable, empty/invalid output, errors).
 */
export function buildFallbackNarration(
  inputParagraphs: NarrationInputParagraph[]
): GenerateNarrationResult {
  const { narrationText, paragraphMap } = buildAlignedNarration(
    inputParagraphs.map((p) => ({ o: p.o, text: spokenScripts(p.text) }))
  );
  return {
    text: narrationText,
    source: "fallback",
    paragraphMap,
  };
}

/**
 * Result of narration generation.
 */
export interface GenerateNarrationResult {
  /** The generated narration text */
  text: string;
  /** Whether this was generated by LLM or fallback */
  source: "llm" | "fallback";
  /**
   * Paragraph mapping for highlighting.
   * Maps each narration paragraph index to its original HTML element index.
   * This is needed because some HTML elements (like ul/ol containers, empty elements)
   * don't produce narration text, causing indices to diverge.
   */
  paragraphMap: ParagraphMapEntry[];
  /** Set on a fallback served because the model's answer couldn't be used. */
  failure?: Extract<NarrationFailure, { kind: "unusable_output" }>;
}

/** Why the model's narration couldn't be served. */
export type NarrationFailure =
  /** It answered, but with nothing usable. */
  | {
      kind: "unusable_output";
      /**
       * It ran on the user's terms: a model they picked rather than one anyone
       * gets by default, or their own key (whose account settings and limits
       * are theirs alone).
       */
      onCallerTerms: boolean;
    }
  /** The call failed (what `generateNarration` threw). */
  | { kind: "error"; error: unknown };

/**
 * Whose problem a narration failure is, which decides whether it's recorded
 * on the `narration_content` row. That row is shared by everyone narrating
 * the same content, so only a failure the content itself causes may back them
 * all off:
 * - `content`: a default model on the server's key couldn't narrate this
 *   content; it would most likely fail the same way again for anyone.
 * - `caller`: this user's key or model choice (a refusal on their own key, a
 *   key that can't be read, a model they picked, anything their own key
 *   answered).
 * - `transient`: the provider being busy, down, or refusing the server's key —
 *   nothing to do with the content.
 */
export type NarrationFailureScope = "content" | "caller" | "transient";

export function narrationFailureScope(failure: NarrationFailure): NarrationFailureScope {
  if (failure.kind === "unusable_output") {
    return failure.onCallerTerms ? "caller" : "content";
  }
  const { error } = failure;
  if (!(error instanceof TextGenerationError)) {
    // An unreadable key, or a model that isn't available on these keys.
    return "caller";
  }
  if (error.failure === "rejected" && error.usedUserKey) return "caller";
  return "transient";
}

/** Whether `ref` is a model anyone can get without picking it. */
function isDefaultNarrationModel(ref: ModelRef): boolean {
  const id = formatModelRef(ref.provider, ref.model);
  const configured = process.env.NARRATION_MODEL;
  return (
    Object.values(DEFAULT_NARRATION_MODELS).includes(id) ||
    (!!configured && normalizeModelRef(configured) === id)
  );
}

/**
 * Whose narration a `narration_content` row holds: null for everyone's (a
 * default model, on whichever key), else the user who picked the model.
 */
export type NarrationCacheOwner = { userId: string; model: string } | null;

/** The {@link NarrationCacheOwner} of `userId`'s narration with `ref`. */
export function narrationCacheOwner(ref: ModelRef, userId: string): NarrationCacheOwner {
  return isDefaultNarrationModel(ref)
    ? null
    : { userId, model: formatModelRef(ref.provider, ref.model) };
}

/**
 * The `narration_content.content_hash` for narrating `sourceContent`: the
 * narration format (a stored paragraph map only means anything against the
 * numbering that produced it, so a bump misses rather than mis-highlights)
 * and the exact content, plus the owner when it isn't everyone's. All in the
 * key rather than in columns, so the release that wrote a row and the one
 * reading it can never disagree: a rollback looks somewhere else instead of
 * overwriting a row it would misread. A model
 * someone picked writes what that user's model says, so its output must never
 * be served to, or overwrite, anyone else's. The owner goes before the
 * feed-controlled content behind a separator the shared form never has right
 * after the version (a space, not a newline), so no content can collide with
 * an owned slot.
 */
export function narrationContentHash(sourceContent: string, owner: NarrationCacheOwner): string {
  const header = owner
    ? `${NARRATION_FORMAT_VERSION} ${JSON.stringify([owner.userId, owner.model])}`
    : `${NARRATION_FORMAT_VERSION}`;
  return createHash("sha256").update(`${header}\n${sourceContent}`, "utf8").digest("hex");
}

/**
 * The narration in the model's raw JSON answer, or null if there's none to
 * use (empty, not JSON, or not shaped like the request). Each input paragraph
 * takes the model's rewrite of its id, or keeps its own text if the model
 * left that id out; a rewrite of `""` drops the paragraph (the model judged
 * it junk), leaving it no narration paragraph and no map entry.
 * `buildAlignedNarration` keeps the map aligned to the player's paragraph
 * split even if a rewrite contains blank-line breaks.
 */
export function narrationFromLlmOutput(
  inputParagraphs: NarrationInputParagraph[],
  rawOutput: string
): GenerateNarrationResult | null {
  if (!rawOutput) return null;
  let json: unknown;
  try {
    json = JSON.parse(rawOutput);
  } catch {
    return null;
  }
  const parsed = llmOutputSchema.safeParse(json);
  if (!parsed.success) return null;

  const llmTextMap = new Map<number, string>();
  for (const p of parsed.data.paragraphs) {
    if (!isNaN(p.id)) {
      llmTextMap.set(p.id, p.text);
    }
  }
  const { narrationText, paragraphMap } = buildAlignedNarration(
    inputParagraphs.map((inputPara) => ({
      o: inputPara.o,
      // Also the model's own text, should it keep a mark.
      text: spokenScripts(llmTextMap.get(inputPara.id) ?? inputPara.text),
    }))
  );
  return { text: narrationText, source: "llm", paragraphMap };
}

/**
 * Generates narration-ready text from HTML content with `modelRef`, which the
 * caller has checked can be used ({@link isNarrationModelUsable}).
 *
 * Uses structured JSON input/output with per-paragraph fallback: an answer
 * that can't be used comes back as the plain-text fallback, with `failure` set.
 *
 * @throws if the provider call fails (the caller logs it and serves the fallback)
 */
async function generateNarration(
  htmlContent: string,
  options: { keys: AiProviderKeys; modelRef: ModelRef }
): Promise<GenerateNarrationResult> {
  const { keys, modelRef } = options;
  const { paragraphs: inputParagraphs } = htmlToNarrationInput(htmlContent);

  const rawOutput = await generateChatCompletion(modelRef, keys, "narrationTextProcessing", {
    system: NARRATION_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({ paragraphs: inputParagraphs }),
    // Mechanical text normalization task — minimal reasoning keeps latency and
    // token cost low. gpt-oss emits any reasoning in a separate `reasoning`
    // field, so the response content is still the clean JSON we parse below.
    reasoningEffort: "low",
    jsonObject: true,
    temperature: 0.1, // Low temperature for consistency
    // Output must echo back every rewritten paragraph for the whole article,
    // and reasoning models spend some of this budget on reasoning tokens even
    // at "low" effort. Keep the cap high so long articles don't truncate into
    // the (uncached, retried after a backoff) fallback path. We only pay for
    // tokens actually generated.
    maxTokens: 16000,
  });

  const narration = narrationFromLlmOutput(inputParagraphs, rawOutput);
  if (narration) return narration;

  logger.warn("Narration LLM output was empty or unusable, using fallback", {
    provider: modelRef.provider,
    rawOutput: rawOutput.substring(0, 200),
  });
  trackNarrationHighlightFallback();
  return {
    ...buildFallbackNarration(inputParagraphs),
    failure: {
      kind: "unusable_output",
      onCallerTerms: !isDefaultNarrationModel(modelRef) || isOnUserKey(modelRef.provider, keys),
    },
  };
}

/**
 * Whether `ref` can preprocess narration on `keys`: the plan includes it and
 * the model can be used (see `isModelAllowed`).
 */
async function isNarrationModelUsable(ref: ModelRef, keys?: AiProviderKeys): Promise<boolean> {
  return (
    planIncludesFeature(keys, ref.provider, "narrationTextProcessing") &&
    (await isTextModelAllowed(formatModelRef(ref.provider, ref.model), keys))
  );
}

/**
 * Checks if LLM narration preprocessing is available: the configured
 * narration model can be used (see `isModelAllowed`).
 */
export async function isNarrationLlmAvailable(
  keys?: AiProviderKeys,
  userModel?: string | null
): Promise<boolean> {
  return isNarrationModelUsable(await getNarrationModelRef(userModel, keys), keys);
}

/**
 * Time to wait before retrying the LLM after a failure the content caused.
 */
const RETRY_AFTER_MS = 60 * 60 * 1000;

/** An entry's narration, as `narration.generate` returns it. */
export interface EntryNarration {
  narration: string;
  /** Served from `narration_content` rather than generated now. */
  cached: boolean;
  source: "llm" | "fallback";
  /** Maps each narration paragraph index to its original HTML element index. */
  paragraphMap: ParagraphMapEntry[];
}

/**
 * The narration of the entry variant `user` is looking at.
 *
 * Looks up existing narration by content hash for deduplication. If there's
 * none, calls the LLM and caches what it says. Falls back to plain text when
 * the LLM is off, unavailable, recently failed on this content, or errors.
 *
 * @throws entryNotFound if the entry isn't visible to the user
 */
export async function getEntryNarration(
  db: typeof dbType,
  user: { id: string; narrationModel: string | null },
  input: {
    id: string;
    /** When false, uses simple HTML-to-text conversion. */
    useLlmNormalization: boolean;
    showFullContent: boolean;
    showOriginal: boolean;
  }
): Promise<EntryNarration> {
  // Fetch API keys from DB on demand (not loaded with the session user)
  const keys = await getUserApiKeys(user.id);

  // Fetch the entry with the same visibility rule the entry list applies.
  // Both regular entries and saved articles are in the entries table now.
  const entry = await getOwnedEntryRawContent(db, user.id, input.id);

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
      source: "fallback",
      paragraphMap: [],
    };
  }

  // The model this request narrates with, resolved once: the cache slot
  // it reads (see narrationContentHash) and the call that fills it must
  // agree on whose output it is.
  const modelRef = await getNarrationModelRef(user.narrationModel, keys);
  const contentHash = narrationContentHash(sourceContent, narrationCacheOwner(modelRef, user.id));

  const selectByContentHash = () =>
    db
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
    const inserted = await db
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
      source: "llm",
      paragraphMap: narrationRecord.paragraphMap,
    };
  }

  // Plain-text narration with a paragraph map aligned to the player's split.
  const fallbackResponse = (
    result = buildFallbackNarration(htmlToNarrationInput(sourceContent).paragraphs)
  ): EntryNarration => {
    trackNarrationGenerated(false, "fallback");
    return {
      narration: result.text,
      cached: false,
      source: "fallback",
      paragraphMap: result.paragraphMap,
    };
  };

  // Check if we should retry after a previous error
  const canRetryLLM =
    !narrationRecord.errorAt || Date.now() - narrationRecord.errorAt.getTime() > RETRY_AFTER_MS;

  // If user disabled LLM normalization, the model can't be used, or we had a recent error, fall back to plain text
  if (
    !input.useLlmNormalization ||
    !(await isNarrationModelUsable(modelRef, keys)) ||
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
    await db
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
    await db
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
      source: "llm",
      paragraphMap: result.paragraphMap,
    };
  } catch (error) {
    // Stop the timer even on error
    stopTimer();

    // Out of the plan's narration cleanup: plain text is the narration it
    // gets, and nothing failed.
    if (getAppErrorCode(error) === "QUOTA_EXCEEDED") {
      return fallbackResponse();
    }

    logger.error("Narration generation failed", {
      contentHash,
      provider: modelRef.provider,
      model: modelRef.model,
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
}
