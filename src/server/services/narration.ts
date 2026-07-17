/**
 * Narration service for LLM-based text preprocessing.
 *
 * Uses an OpenAI-compatible provider (Groq or Cerebras, default Groq
 * GPT-OSS 20B) to convert article HTML to narration-ready text for
 * text-to-speech. Falls back to simple HTML stripping when no provider is
 * available.
 */

import { z } from "zod";
import { logger } from "@/lib/logger";
import { parseModelRef, type ModelRef } from "@/lib/ai/model-ref";
import { DEFAULT_NARRATION_MODEL } from "@/lib/narration/constants";
import {
  generateChatCompletion,
  isProviderAvailable,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import { htmlToNarrationInput } from "@/lib/narration/html-to-narration-input";
import { buildAlignedNarration, type ParagraphMapEntry } from "@/lib/narration/paragraph-map";
import type { NarrationInputParagraph } from "@/lib/narration/html-to-narration-input";
import { trackNarrationHighlightFallback } from "@/server/metrics/metrics";

// Re-export pure functions for backward compatibility
export { htmlToNarrationInput };
export type { ParagraphMapEntry };

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

type LLMOutput = z.infer<typeof llmOutputSchema>;

/**
 * System prompt for the Groq LLM to convert article content to narration-ready text.
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
    { "id": 6, "text": "..." }
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
    { "id": 6, "text": "" }
  ]
}

Return ONLY valid JSON.`;

/**
 * Resolves the narration model as a `provider:model` reference.
 * Priority: user setting > `NARRATION_MODEL` env var > default.
 *
 * Narration preprocessing requires JSON-object responses, which only the
 * OpenAI-compatible providers support — a reference that resolves to another
 * provider (e.g. a legacy bare model ID) falls back to the default model.
 */
export function getNarrationModelRef(userModel?: string | null): ModelRef {
  const ref = parseModelRef(userModel || process.env.NARRATION_MODEL || DEFAULT_NARRATION_MODEL);
  if (ref.provider !== "groq" && ref.provider !== "cerebras") {
    return parseModelRef(DEFAULT_NARRATION_MODEL);
  }
  return ref;
}

/**
 * Builds a fallback narration result (plain input text, no LLM) with a paragraph
 * map aligned to how the player splits paragraphs. Shared by every fallback arm
 * (no Groq key, empty/invalid LLM response).
 */
function buildFallbackNarration(
  inputParagraphs: NarrationInputParagraph[]
): GenerateNarrationResult {
  const { narrationText, paragraphMap } = buildAlignedNarration(
    inputParagraphs.map((p) => ({ o: p.id, text: p.text }))
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
  }
): Promise<GenerateNarrationResult> {
  const modelRef = getNarrationModelRef(options?.userModel);

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
      // so long articles don't truncate into the (uncached, repeatedly-retried)
      // fallback path. We only pay for tokens actually generated.
      maxTokens: 16000,
    });

    if (!rawOutput) {
      logger.warn("Narration LLM returned empty response, using fallback", {
        provider: modelRef.provider,
      });
      trackNarrationHighlightFallback();
      return buildFallbackNarration(inputParagraphs);
    }

    // Parse and validate JSON output
    let llmOutput: LLMOutput;
    try {
      const parsed = JSON.parse(rawOutput);
      llmOutput = llmOutputSchema.parse(parsed);
    } catch (parseError) {
      logger.warn("Failed to parse or validate LLM JSON output, using fallback", {
        error: parseError instanceof Error ? parseError.message : String(parseError),
        rawOutput: rawOutput.substring(0, 200), // Log first 200 chars for debugging
      });
      trackNarrationHighlightFallback();
      return buildFallbackNarration(inputParagraphs);
    }

    // Build a Map from LLM output: id → text
    const llmTextMap = new Map<number, string>();
    for (const p of llmOutput.paragraphs) {
      if (!isNaN(p.id)) {
        llmTextMap.set(p.id, p.text);
      }
    }

    // For each input paragraph, pick the LLM's rewrite (falling back to the
    // original input text when the LLM omitted that id). An empty string means
    // the LLM deliberately dropped the paragraph (junk/garbage) — it produces
    // no narration paragraph and no map entry. `buildAlignedNarration` filters
    // empties and, crucially, keeps the map aligned to the player's paragraph
    // split even if a rewrite contains blank-line breaks.
    const elements = inputParagraphs.map((inputPara) => {
      const llmText = llmTextMap.get(inputPara.id);
      return {
        o: inputPara.id,
        text: llmText !== undefined ? llmText : inputPara.text,
      };
    });

    const { narrationText, paragraphMap } = buildAlignedNarration(elements);

    return {
      text: narrationText,
      source: "llm",
      paragraphMap,
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
 * narration model's provider has a user or server key set.
 */
export function isNarrationLlmAvailable(keys?: AiProviderKeys, userModel?: string | null): boolean {
  return isProviderAvailable(getNarrationModelRef(userModel).provider, keys);
}
