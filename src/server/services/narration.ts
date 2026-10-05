/**
 * Narration service for LLM-based text preprocessing.
 *
 * Uses a text provider from the registry (`@/lib/ai/providers`) that supports
 * JSON-object responses to convert article HTML to narration-ready text for
 * text-to-speech. Falls back to simple HTML stripping when no provider is
 * available.
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { logger } from "@/lib/logger";
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
  isProviderAvailable,
  isTextModelAllowed,
  TextGenerationError,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import { htmlToNarrationInput } from "@/lib/narration/html-to-narration-input";
import { buildAlignedNarration, type ParagraphMapEntry } from "@/lib/narration/paragraph-map";
import type { NarrationInputParagraph } from "@/lib/narration/html-to-narration-input";
import { trackNarrationHighlightFallback } from "@/server/metrics/metrics";

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
- Bracketed footnote/citation markers are spoken in parentheses: "[1]" → "(footnote 1)". Only reference markers: leave other brackets ("[sic]", "arr[0]") as they are
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
    { "id": 7, "text": "It shipped in 2019.[2]" }
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
    { "id": 7, "text": "It shipped in 2019 (footnote 2)." }
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
 * map aligned to how the player splits paragraphs. Shared by every fallback arm,
 * here and in the narration router (LLM off/unavailable, empty/invalid output, errors).
 */
export function buildFallbackNarration(
  inputParagraphs: NarrationInputParagraph[]
): GenerateNarrationResult {
  const { narrationText, paragraphMap } = buildAlignedNarration(
    inputParagraphs.map((p) => ({ o: p.o, text: p.text }))
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
      text: llmTextMap.get(inputPara.id) ?? inputPara.text,
    }))
  );
  return { text: narrationText, source: "llm", paragraphMap };
}

/**
 * Generates narration-ready text from HTML content using an LLM.
 *
 * Uses structured JSON input/output with per-paragraph fallback.
 * If no provider key is configured or JSON parsing fails, falls back to
 * simple HTML-to-text conversion.
 *
 * @param htmlContent - HTML content to convert to narration
 * @param options - Per-user provider keys and optional model override
 * @returns Object containing the narration text and source
 * @throws Error if the provider API call fails (caller should handle and use fallback)
 *
 * @example
 * try {
 *   const result = await generateNarration('<p>Hello, Dr. Smith!</p>');
 *   console.log(result.text); // "Hello, Doctor Smith!"
 *   console.log(result.source); // "llm"
 * } catch (error) {
 *   console.error('Narration LLM failed:', error);
 *   // Use htmlToPlainText as fallback
 * }
 */
export async function generateNarration(
  htmlContent: string,
  options?: {
    keys?: AiProviderKeys;
    userModel?: string | null;
    /** The model already resolved from `userModel` (see `getNarrationModelRef`). */
    modelRef?: ModelRef;
  }
): Promise<GenerateNarrationResult> {
  const modelRef =
    options?.modelRef ?? (await getNarrationModelRef(options?.userModel, options?.keys));

  // Convert HTML to structured paragraphs
  const { paragraphs: inputParagraphs } = htmlToNarrationInput(htmlContent);

  // If the model's provider is not configured, use fallback
  if (!isProviderAvailable(modelRef.provider, options?.keys)) {
    logger.debug("Narration LLM provider not configured, using fallback text conversion", {
      provider: modelRef.provider,
    });
    trackNarrationHighlightFallback();
    return buildFallbackNarration(inputParagraphs);
  }

  try {
    // Send paragraphs as JSON
    const userPrompt = JSON.stringify({ paragraphs: inputParagraphs });

    const rawOutput = await generateChatCompletion(modelRef, options?.keys, {
      system: NARRATION_SYSTEM_PROMPT,
      userPrompt,
      // Mechanical text normalization task — minimal reasoning keeps latency and
      // token cost low. gpt-oss emits any reasoning in a separate `reasoning`
      // field, so the response content is still the clean JSON we parse below.
      reasoningEffort: "low",
      jsonObject: true, // Request JSON output
      temperature: 0.1, // Low temperature for consistency
      // Output must echo back every rewritten paragraph for the whole article,
      // and (unlike the old non-reasoning llama-3.1-8b) gpt-oss spends some of
      // this budget on reasoning tokens even at "low" effort. Keep the cap high
      // so long articles don't truncate into the (uncached, retried after a backoff)
      // fallback path. We only pay for tokens actually generated.
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
        onCallerTerms:
          !isDefaultNarrationModel(modelRef) || isOnUserKey(modelRef.provider, options?.keys),
      },
    };
  } catch (error) {
    // Log the error and re-throw so caller can handle
    logger.error("Narration LLM call failed", {
      provider: modelRef.provider,
      model: modelRef.model,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Checks if LLM narration preprocessing is available: the configured
 * narration model can be used (see `isModelAllowed`).
 */
export async function isNarrationLlmAvailable(
  keys?: AiProviderKeys,
  userModel?: string | null
): Promise<boolean> {
  const ref = await getNarrationModelRef(userModel, keys);
  return isTextModelAllowed(formatModelRef(ref.provider, ref.model), keys);
}
