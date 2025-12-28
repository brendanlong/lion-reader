/**
 * Narration service for LLM-based text preprocessing.
 *
 * Uses Groq (Llama 3.1 8B) to convert article HTML to narration-ready text
 * for text-to-speech. Falls back to simple HTML stripping when Groq is unavailable.
 */

import { createHash } from "crypto";
import Groq from "groq-sdk";
import { logger } from "@/lib/logger";

/**
 * System prompt for the Groq LLM to convert article content to narration-ready text.
 */
export const NARRATION_SYSTEM_PROMPT = `Convert this article to narration-ready plain text for text-to-speech.

Rules:
- Output ONLY the article text—no preamble, commentary, or "here is the cleaned article"
- Output plain text with blank lines between paragraphs
- Call out special content: "Code block: ... End code block.", "Image: [alt].", "Table with N columns: ..."
- Expand abbreviations (Dr. → Doctor, etc. → et cetera, px → pixels)
- Read URLs as "link to [domain]" or skip if already in link text
- Convert lists to numbered format (1. ... 2. ... 3. ...) to preserve structure
- Split very long paragraphs at natural points
- Keep the content faithful to the original—do not summarize or editorialize`;

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
 * Converts HTML to structured text for LLM processing.
 * Preserves semantic information like headings, lists, code blocks, and images
 * to help the LLM generate appropriate narration.
 *
 * @param html - HTML content to convert
 * @returns Structured text suitable for LLM processing
 *
 * @example
 * const input = htmlToNarrationInput('<h2>Title</h2><p>Content</p>');
 * // Returns "[HEADING] Title\n\nContent"
 */
export function htmlToNarrationInput(html: string): string {
  let result = html;

  // Mark headings with semantic indicators
  result = result.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n\n[HEADING] $1\n\n");
  result = result.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n\n[HEADING] $1\n\n");
  result = result.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n\n[SUBHEADING] $1\n\n");
  result = result.replace(/<h[4-6][^>]*>([\s\S]*?)<\/h[4-6]>/gi, "\n\n[SUBHEADING] $1\n\n");

  // Mark code blocks
  result = result.replace(
    /<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi,
    "\n\n[CODE BLOCK]\n$1\n[END CODE BLOCK]\n\n"
  );
  result = result.replace(
    /<pre[^>]*>([\s\S]*?)<\/pre>/gi,
    "\n\n[CODE BLOCK]\n$1\n[END CODE BLOCK]\n\n"
  );

  // Mark inline code (but don't add line breaks)
  result = result.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`");

  // Mark blockquotes
  result = result.replace(
    /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi,
    "\n\n[QUOTE]\n$1\n[END QUOTE]\n\n"
  );

  // Handle images - extract alt text
  result = result.replace(/<img[^>]*alt=["']([^"']+)["'][^>]*>/gi, "\n\n[IMAGE: $1]\n\n");
  result = result.replace(/<img[^>]*>/gi, "\n\n[IMAGE: no description]\n\n");

  // Handle links - preserve link text, add URL for context
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

  // Handle lists - mark list items
  result = result.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1");
  result = result.replace(/<\/?[ou]l[^>]*>/gi, "\n");

  // Handle tables - mark them for LLM to process
  result = result.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, "\n\n[TABLE]\n$1\n[END TABLE]\n\n");
  result = result.replace(/<tr[^>]*>/gi, "\n[ROW] ");
  result = result.replace(/<\/tr>/gi, "");
  result = result.replace(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi, "$1 | ");

  // Handle paragraphs and divs
  result = result.replace(/<(p|div)[^>]*>/gi, "\n\n");
  result = result.replace(/<\/(p|div)>/gi, "\n\n");

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

  return result.trim();
}

/**
 * Result of narration generation.
 */
export interface GenerateNarrationResult {
  /** The generated narration text */
  text: string;
  /** Whether this was generated by LLM or fallback */
  source: "llm" | "fallback";
}

/**
 * Generates narration-ready text from HTML content using Groq LLM.
 *
 * If GROQ_API_KEY is not set, falls back to simple HTML-to-text conversion.
 *
 * @param htmlContent - HTML content to convert to narration
 * @returns Object containing the narration text and its source
 * @throws Error if Groq API call fails (caller should handle and use fallback)
 *
 * @example
 * try {
 *   const result = await generateNarration('<p>Hello, Dr. Smith!</p>');
 *   console.log(result.text); // "Hello, Doctor Smith!"
 *   console.log(result.source); // "llm"
 * } catch (error) {
 *   console.error('Groq API failed:', error);
 *   // Use htmlToPlainText as fallback
 * }
 */
export async function generateNarration(htmlContent: string): Promise<GenerateNarrationResult> {
  const client = getGroqClient();

  // If Groq is not configured, use fallback
  if (!client) {
    logger.debug("Groq API key not configured, using fallback text conversion");
    return {
      text: htmlToPlainText(htmlContent),
      source: "fallback",
    };
  }

  // Convert HTML to structured text for LLM
  const textContent = htmlToNarrationInput(htmlContent);

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
          content: textContent,
        },
      ],
      temperature: 0.1, // Low temperature for consistency
      max_tokens: 8000,
    });

    const narrationText = response.choices[0]?.message?.content;

    if (!narrationText) {
      logger.warn("Groq returned empty response, using fallback");
      return {
        text: htmlToPlainText(htmlContent),
        source: "fallback",
      };
    }

    return {
      text: narrationText,
      source: "llm",
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
