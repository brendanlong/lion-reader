/**
 * Narration service for LLM-based text preprocessing.
 *
 * Uses Groq (Llama 3.1 8B) to convert article HTML to narration-ready text
 * for text-to-speech. Falls back to simple HTML stripping when Groq is unavailable.
 */

import { createHash } from "crypto";
import Groq from "groq-sdk";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { createPositionalMapping } from "@/lib/narration/paragraph-mapping";
import {
  htmlToNarrationInput,
  htmlToPlainText,
  type HtmlToNarrationInputResult,
} from "@/lib/narration/html-to-narration-input";
import { trackNarrationHighlightFallback } from "@/server/metrics";

// Re-export pure functions for backward compatibility
export { htmlToNarrationInput, htmlToPlainText, type HtmlToNarrationInputResult };

/**
 * Schema for a single narration paragraph from the LLM.
 */
const narrationParagraphSchema = z.object({
  /** Original paragraph IDs this narration came from (e.g., ["para-0"] or ["para-1", "para-2"]) */
  sourceIds: z.array(z.string()),
  /** The narration text to be spoken */
  text: z.string(),
});

/**
 * Schema for the LLM's structured JSON output.
 */
const llmOutputSchema = z.object({
  paragraphs: z.array(narrationParagraphSchema),
});

type LLMOutput = z.infer<typeof llmOutputSchema>;

/**
 * System prompt for the Groq LLM to convert article content to narration-ready text.
 *
 * Now requests structured JSON output with explicit source paragraph tracking.
 */
export const NARRATION_SYSTEM_PROMPT = `Convert this article to narration-ready plain text for text-to-speech.

You will receive paragraphs with IDs like "para-0", "para-1", etc. Your job is to convert them
to natural-sounding narration text while tracking which original paragraphs each narration section came from.

CRITICAL RULES FOR IMAGES AND ALT TEXT:
- When you see "[IMAGE: alt text]", read it LITERALLY as "Image: alt text" or "Image, alt text"
- DO NOT rephrase, interpret, or embellish the alt text
- DO NOT add descriptions like "showing" or "depicting" - just read the alt text as-is
- Examples:
  - "[IMAGE: diagram]" → "Image: diagram" (NOT "Image showing a diagram")
  - "[IMAGE: Photo of a cat]" → "Image: Photo of a cat" (read exactly as written)

General rules:
- Expand ALL abbreviations (Dr. → Doctor, etc. → et cetera, px → pixel or pixels)
- Read URLs as "link to [domain]" or skip if already in link text
- Preserve numbers in numbered lists
- Keep content faithful to original - do NOT summarize or editorialize
- You may combine multiple paragraphs into one narration section if it flows better
- You may split long paragraphs for better pacing

Output ONLY valid JSON in this exact format:
{
  "paragraphs": [
    {
      "sourceIds": ["para-0"],
      "text": "Introduction."
    },
    {
      "sourceIds": ["para-1", "para-2"],
      "text": "Doctor Smith said this is important. Here's more detail."
    }
  ]
}

Example input:
---
para-0: [HEADING] Introduction
para-1: Dr. Smith said this is important.
para-2: [IMAGE: diagram showing architecture]
para-3: The diagram illustrates the system.
---

Example output:
{
  "paragraphs": [
    {
      "sourceIds": ["para-0"],
      "text": "Introduction."
    },
    {
      "sourceIds": ["para-1"],
      "text": "Doctor Smith said this is important."
    },
    {
      "sourceIds": ["para-2"],
      "text": "Image: diagram showing architecture."
    },
    {
      "sourceIds": ["para-3"],
      "text": "The diagram illustrates the system."
    }
  ]
}`;

/**
 * User prompt template that presents paragraphs to the LLM in a structured format.
 */
function createUserPrompt(paragraphOrder: string[], inputText: string): string {
  // Parse the input text to extract each paragraph with its marker
  const lines = inputText.split("\n\n");
  const paragraphTexts = lines.map((line) => {
    const match = line.match(/^\[P:(\d+)\]\s*(.*)$/);
    if (match) {
      const index = parseInt(match[1], 10);
      const text = match[2];
      return `${paragraphOrder[index]}: ${text}`;
    }
    return line;
  });

  return paragraphTexts.join("\n");
}

/**
 * Groq client instance. Only initialized when GROQ_API_KEY is set.
 */
let groqClient: Groq | null = null;

/**
 * Gets or creates the Groq client instance.
 * Returns null if GROQ_API_KEY is not set.
 */
function getGroqClient(): Groq | null {
  if (!process.env.GROQ_API_KEY) {
    return null;
  }

  if (!groqClient) {
    groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }

  return groqClient;
}

/**
 * Computes a SHA-256 hash of the content.
 * Used for deduplication of narration content.
 *
 * @param content - The content to hash
 * @returns Hexadecimal SHA-256 hash string
 *
 * @example
 * const hash = computeContentHash('<p>Hello, world!</p>');
 * // Returns something like "a591a6d40bf..."
 */
export function computeContentHash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Compact paragraph mapping for database storage.
 * Maps narration paragraph index to original paragraph indices.
 */
export interface ParagraphMapEntry {
  /** Narration paragraph index */
  n: number;
  /** Original paragraph indices (can be multiple if LLM combined) */
  o: number[];
}

/**
 * Result of narration generation.
 */
export interface GenerateNarrationResult {
  /** The generated narration text */
  text: string;
  /** Whether this was generated by LLM or fallback */
  source: "llm" | "fallback";
  /** Paragraph mapping for highlighting (narration index -> original indices) */
  paragraphMap: ParagraphMapEntry[];
}

/**
 * Creates a paragraph mapping for fallback narration (no LLM).
 * Uses positional 1:1 mapping between narration and original paragraphs.
 *
 * @param text - The fallback narration text
 * @param originalParagraphCount - Number of paragraphs in original content
 * @returns Array of paragraph map entries
 */
function createFallbackParagraphMap(
  text: string,
  originalParagraphCount: number
): ParagraphMapEntry[] {
  // Count paragraphs in the fallback text
  const narrationParagraphs = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const mapping = createPositionalMapping(narrationParagraphs.length, originalParagraphCount);

  return mapping.map((m) => ({
    n: m.narrationIndex,
    o: m.originalIndices,
  }));
}

/**
 * Generates narration-ready text from HTML content using Groq LLM.
 *
 * Uses structured JSON output for robust paragraph mapping.
 * If GROQ_API_KEY is not set or JSON parsing fails, falls back to simple HTML-to-text conversion.
 *
 * The function returns a paragraph mapping that maps each narration paragraph
 * to the original HTML paragraph(s) it was derived from. This enables highlighting
 * the current paragraph during audio playback.
 *
 * @param htmlContent - HTML content to convert to narration
 * @returns Object containing the narration text, source, and paragraph mapping
 * @throws Error if Groq API call fails (caller should handle and use fallback)
 *
 * @example
 * try {
 *   const result = await generateNarration('<p>Hello, Dr. Smith!</p>');
 *   console.log(result.text); // "Hello, Doctor Smith!"
 *   console.log(result.source); // "llm"
 *   console.log(result.paragraphMap); // [{ n: 0, o: [0] }]
 * } catch (error) {
 *   console.error('Groq API failed:', error);
 *   // Use htmlToPlainText as fallback
 * }
 */
export async function generateNarration(htmlContent: string): Promise<GenerateNarrationResult> {
  const client = getGroqClient();

  // Convert HTML to structured text for LLM with paragraph markers
  const { inputText, paragraphOrder } = htmlToNarrationInput(htmlContent);

  // If Groq is not configured, use fallback
  if (!client) {
    logger.debug("Groq API key not configured, using fallback text conversion");
    trackNarrationHighlightFallback();
    const fallbackText = htmlToPlainText(htmlContent);
    return {
      text: fallbackText,
      source: "fallback",
      paragraphMap: createFallbackParagraphMap(fallbackText, paragraphOrder.length),
    };
  }

  try {
    // Create structured user prompt
    const userPrompt = createUserPrompt(paragraphOrder, inputText);

    const response = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: NARRATION_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: userPrompt,
        },
      ],
      response_format: { type: "json_object" }, // Request JSON output
      temperature: 0.1, // Low temperature for consistency
      max_tokens: 8000,
    });

    const rawOutput = response.choices[0]?.message?.content;

    if (!rawOutput) {
      logger.warn("Groq returned empty response, using fallback");
      trackNarrationHighlightFallback();
      const fallbackText = htmlToPlainText(htmlContent);
      return {
        text: fallbackText,
        source: "fallback",
        paragraphMap: createFallbackParagraphMap(fallbackText, paragraphOrder.length),
      };
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
      const fallbackText = htmlToPlainText(htmlContent);
      return {
        text: fallbackText,
        source: "fallback",
        paragraphMap: createFallbackParagraphMap(fallbackText, paragraphOrder.length),
      };
    }

    // Convert structured output to narration text and paragraph mapping
    const narrationText = llmOutput.paragraphs.map((p) => p.text).join("\n\n");

    const paragraphMap: ParagraphMapEntry[] = llmOutput.paragraphs.map((p, narrationIndex) => {
      // Extract original paragraph indices from sourceIds (e.g., "para-0" -> 0)
      const originalIndices = p.sourceIds
        .map((id) => {
          const match = id.match(/^para-(\d+)$/);
          if (!match) {
            logger.warn(`Invalid sourceId format: ${id}, skipping`);
            return -1;
          }
          return parseInt(match[1], 10);
        })
        .filter((idx) => idx !== -1);

      return {
        n: narrationIndex,
        o: originalIndices.length > 0 ? originalIndices : [narrationIndex], // Fallback to positional if parsing failed
      };
    });

    return {
      text: narrationText,
      source: "llm",
      paragraphMap,
    };
  } catch (error) {
    // Log the error and re-throw so caller can handle
    logger.error("Groq API call failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Checks if Groq integration is available.
 *
 * @returns true if GROQ_API_KEY is set
 */
export function isGroqAvailable(): boolean {
  return !!process.env.GROQ_API_KEY;
}
