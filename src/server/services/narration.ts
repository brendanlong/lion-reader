/**
 * Narration service for LLM-based text preprocessing.
 *
 * Uses Groq (Llama 3.1 8B) to convert article HTML to narration-ready text
 * for text-to-speech. Falls back to simple HTML stripping when Groq is unavailable.
 */

import { createHash } from "crypto";
import Groq from "groq-sdk";
import { logger } from "@/lib/logger";
import {
  parseNarrationOutput,
  createPositionalMapping,
  hasParaMarkers,
} from "@/lib/narration/paragraph-mapping";
import { trackNarrationHighlightFallback } from "@/server/metrics";

/**
 * System prompt for the Groq LLM to convert article content to narration-ready text.
 * Includes instructions for paragraph markers to enable highlighting during playback.
 */
export const NARRATION_SYSTEM_PROMPT = `Convert this article to narration-ready plain text for text-to-speech.

IMPORTANT: Insert paragraph markers to track which original paragraph each narration section comes from.
- The input has [P:X] markers where X is the original paragraph number (starting from 0)
- In your output, use [PARA:X] markers at the START of each section
- If you combine paragraphs, include all their markers: [PARA:2][PARA:3]
- If you skip content (like complex tables), still include the marker with a note
- Place markers at the very beginning of each paragraph, before any text

Rules:
- Output ONLY the article text—no preamble, commentary, or "here is the cleaned article"
- Output plain text with blank lines between paragraphs
- Call out special content: "Code block: ... End code block.", "Image: [alt].", "Table: ..."
- Expand ALL abbreviations (Dr. → Doctor, etc. → et cetera, px → pixel or pixels)
- Read URLs as "link to [domain]" or skip if already in link text
- Preserve the numbers in numbered lists
- Split very long paragraphs at natural points (keep the same marker)
- Keep the content faithful to the original—do NOT summarize or editorialize

Example input:
---
[P:0] [HEADING] Introduction

[P:1] Dr. Smith said this is important.

[P:2] [CODE BLOCK]
npm install
[END CODE BLOCK]
---

Example output:
---
[PARA:0]Introduction.

[PARA:1]Doctor Smith said this is important.

[PARA:2]Code block: npm install. End code block.
---`;

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
 * Converts HTML to plain text for fallback mode.
 * Basic conversion that strips tags but preserves structure.
 *
 * @param html - HTML content to convert
 * @returns Plain text with paragraph breaks
 *
 * @example
 * const text = htmlToPlainText('<p>Hello</p><p>World</p>');
 * // Returns "Hello\n\nWorld"
 */
export function htmlToPlainText(html: string): string {
  return (
    html
      // Add paragraph breaks before block elements
      .replace(/<(p|div|br|h[1-6]|li|tr|blockquote|pre)[^>]*>/gi, "\n\n")
      // Remove all HTML tags
      .replace(/<[^>]+>/g, "")
      // Decode common HTML entities
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&apos;/g, "'")
      // Normalize whitespace: collapse multiple spaces to single space
      .replace(/ +/g, " ")
      // Normalize paragraph breaks: collapse multiple newlines to double newline
      .replace(/\n{3,}/g, "\n\n")
      // Trim whitespace from each line
      .split("\n")
      .map((line) => line.trim())
      .join("\n")
      // Final trim
      .trim()
  );
}

/**
 * Result of converting HTML to narration input.
 */
export interface HtmlToNarrationInputResult {
  /** Text content with [P:X] markers for LLM processing */
  inputText: string;
  /** Array of paragraph identifiers in order they appear */
  paragraphOrder: string[];
}

/**
 * Converts HTML to structured text for LLM processing with paragraph markers.
 * Preserves semantic information like headings, lists, code blocks, and images
 * to help the LLM generate appropriate narration.
 *
 * Adds [P:X] markers to indicate original paragraph indices, which the LLM
 * will transform to [PARA:X] markers in its output for highlighting support.
 *
 * @param html - HTML content to convert
 * @returns Object with inputText (marked text) and paragraphOrder (paragraph IDs)
 *
 * @example
 * const result = htmlToNarrationInput('<h2>Title</h2><p>Content</p>');
 * // Returns {
 * //   inputText: "[P:0] [HEADING] Title\n\n[P:1] Content",
 * //   paragraphOrder: ["para-0", "para-1"]
 * // }
 */
export function htmlToNarrationInput(html: string): HtmlToNarrationInputResult {
  // Track paragraph indices
  let paragraphIndex = 0;
  const paragraphOrder: string[] = [];

  /**
   * Generates the next paragraph marker and records it.
   */
  function nextMarker(): string {
    const id = `para-${paragraphIndex}`;
    paragraphOrder.push(id);
    const marker = `[P:${paragraphIndex}]`;
    paragraphIndex++;
    return marker;
  }

  let result = html;

  // Process headings with paragraph markers
  result = result.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [HEADING] ${content}\n\n`;
  });
  result = result.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [HEADING] ${content}\n\n`;
  });
  result = result.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [SUBHEADING] ${content}\n\n`;
  });
  result = result.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [SUBHEADING] ${content}\n\n`;
  });

  // Mark code blocks with paragraph markers
  result = result.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [CODE BLOCK]\n${content}\n[END CODE BLOCK]\n\n`;
  });
  result = result.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [CODE BLOCK]\n${content}\n[END CODE BLOCK]\n\n`;
  });

  // Mark inline code (but don't add line breaks or markers)
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Mark blockquotes with paragraph markers
  result = result.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [QUOTE]\n${content}\n[END QUOTE]\n\n`;
  });

  // Handle images - extract alt text with paragraph markers
  result = result.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, (_, alt) => {
    const marker = nextMarker();
    return `\n\n${marker} [IMAGE: ${alt}]\n\n`;
  });
  result = result.replace(/<img[^>]*>/gi, () => {
    const marker = nextMarker();
    return `\n\n${marker} [IMAGE: no description]\n\n`;
  });

  // Handle links - preserve link text, add URL for context (no markers, inline)
  result = result.replace(/<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url, text) => {
    const cleanText = text.trim();
    // If link text is the same as URL or empty, just show domain
    if (!cleanText || cleanText === url) {
      try {
        const domain = new URL(url).hostname;
        return `[link to ${domain}]`;
      } catch {
        return `[link to ${url}]`;
      }
    }
    // Otherwise, just use the link text (LLM will handle it)
    return cleanText;
  });

  // Handle lists - mark list items with paragraph markers
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n${marker} - ${content}`;
  });
  result = result.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  // Handle tables - mark them for LLM to process with paragraph markers
  result = result.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} [TABLE]\n${content}\n[END TABLE]\n\n`;
  });
  result = result.replace(/<tr[^>]*>/gi, "\n[ROW] ");
  result = result.replace(/<\/tr>/gi, "");
  result = result.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, "$1 | ");

  // Handle paragraphs with paragraph markers
  result = result.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
    const marker = nextMarker();
    return `\n\n${marker} ${content}\n\n`;
  });

  // Handle divs (no markers, they're containers)
  result = result.replace(/<div[^>]*>/gi, "\n\n");
  result = result.replace(/<\/div>/gi, "\n\n");

  // Handle line breaks
  result = result.replace(/<br\s*\/?>/gi, "\n");

  // Remove remaining HTML tags
  result = result.replace(/<[^>]+>/g, "");

  // Decode common HTML entities
  result = result.replace(/&nbsp;/g, " ");
  result = result.replace(/&amp;/g, "&");
  result = result.replace(/&lt;/g, "<");
  result = result.replace(/&gt;/g, ">");
  result = result.replace(/&quot;/g, '"');
  result = result.replace(/&#39;/g, "'");
  result = result.replace(/&apos;/g, "'");

  // Normalize whitespace
  result = result.replace(/ +/g, " ");
  result = result.replace(/\n{3,}/g, "\n\n");
  result = result
    .split("\n")
    .map((line) => line.trim())
    .join("\n");

  return {
    inputText: result.trim(),
    paragraphOrder,
  };
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
 * If GROQ_API_KEY is not set, falls back to simple HTML-to-text conversion.
 *
 * The function also returns a paragraph mapping that maps each narration paragraph
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
    const response = await client.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        {
          role: "system",
          content: NARRATION_SYSTEM_PROMPT,
        },
        {
          role: "user",
          content: inputText,
        },
      ],
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

    // Track fallback metric if LLM didn't return markers (positional mapping will be used)
    if (!hasParaMarkers(rawOutput)) {
      logger.debug("LLM output has no paragraph markers, using positional mapping fallback");
      trackNarrationHighlightFallback();
    }

    // Parse the LLM output to extract paragraph mapping and clean text
    const { narrationParagraphs, mapping } = parseNarrationOutput(rawOutput, paragraphOrder);
    const narrationText = narrationParagraphs.join("\n\n");

    // Convert mapping to compact format for storage
    const paragraphMap: ParagraphMapEntry[] = mapping.map((m) => ({
      n: m.narrationIndex,
      o: m.originalIndices,
    }));

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
