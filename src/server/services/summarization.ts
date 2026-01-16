/**
 * Summarization service for AI-powered article summaries.
 *
 * Uses Anthropic Claude to generate concise summaries of articles.
 * Summaries are cached by content hash for deduplication across entries.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@/lib/logger";
import { htmlToPlainText } from "@/lib/narration/html-to-narration-input";

/**
 * Current prompt version. Increment this when changing the prompt
 * to invalidate cached summaries.
 */
export const CURRENT_PROMPT_VERSION = 2;

/**
 * Default model for summarization.
 */
const DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Default maximum words for summaries.
 */
const DEFAULT_MAX_WORDS = 300;

/**
 * Maximum content length to send to the LLM (in characters).
 * ~50,000 characters is roughly 12,500 tokens.
 */
const MAX_CONTENT_LENGTH = 50000;

/**
 * Maximum tokens for the summary response.
 */
const MAX_OUTPUT_TOKENS = 1024;

/**
 * Gets the configured max words for summaries.
 */
function getMaxWords(): number {
  const envValue = process.env.SUMMARIZATION_MAX_WORDS;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_WORDS;
}

/**
 * Builds the user prompt for summarization.
 */
function buildSummarizationPrompt(content: string): string {
  const maxWords = getMaxWords();
  return `You will be summarizing content from a blog post or web page for display in an RSS reader app. Your goal is to create a concise, informative summary that captures the main points and helps readers quickly understand what the content is about.

Here is the content to summarize:

<content>
${content}
</content>

Your summary should be no longer than ${maxWords} words.

Please follow these guidelines when creating your summary:

- Focus on the main topic, key points, and most important takeaways from the content
- Include any significant conclusions, findings, or recommendations if present
- Maintain a neutral, informative tone
- Avoid including minor details, tangential information, or excessive examples
- Do not include your own opinions or commentary
- If the content contains multiple distinct sections or topics, briefly mention each main topic
- Write in clear, straightforward language that is easy to scan quickly
- Ensure the summary is self-contained and understandable without needing to read the full content

Your summary must not exceed ${maxWords} words. If the content is very short and already concise, your summary may be shorter than the maximum length.

Write your summary inside <summary> tags.`;
}

/**
 * Extracts the summary from the LLM response.
 * Looks for content within <summary> tags, falling back to the full text.
 */
function extractSummaryFromResponse(responseText: string): string {
  // Try to extract content from <summary> tags
  const summaryMatch = responseText.match(/<summary>([\s\S]*?)<\/summary>/);
  if (summaryMatch) {
    return summaryMatch[1].trim();
  }

  // Fallback: return the full response text (for robustness)
  return responseText.trim();
}

/**
 * Anthropic client instance. Only initialized when ANTHROPIC_API_KEY is set.
 */
let anthropicClient: Anthropic | null = null;

/**
 * Gets or creates the Anthropic client instance.
 * Returns null if ANTHROPIC_API_KEY is not set.
 */
function getAnthropicClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    return null;
  }

  if (!anthropicClient) {
    anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  return anthropicClient;
}

/**
 * Result of summary generation.
 */
export interface GenerateSummaryResult {
  /** The generated summary text */
  summary: string;
  /** The model used for generation */
  modelId: string;
}

/**
 * Prepares HTML content for summarization.
 * Converts to plain text and truncates if necessary.
 */
export function prepareContentForSummarization(htmlContent: string): string {
  // Convert HTML to plain text
  const plainText = htmlToPlainText(htmlContent);

  // Truncate if too long
  if (plainText.length > MAX_CONTENT_LENGTH) {
    return plainText.substring(0, MAX_CONTENT_LENGTH) + "\n\n[Content truncated due to length]";
  }

  return plainText;
}

/**
 * Generates a summary using the Anthropic API.
 *
 * @param content - Plain text content to summarize
 * @returns The generated summary and model ID
 * @throws Error if Anthropic API call fails
 *
 * @example
 * try {
 *   const result = await generateSummary("Long article text here...");
 *   console.log(result.summary);
 * } catch (error) {
 *   console.error('Summarization failed:', error);
 * }
 */
export async function generateSummary(content: string): Promise<GenerateSummaryResult> {
  const client = getAnthropicClient();

  if (!client) {
    throw new Error("Anthropic API key not configured");
  }

  // Get model from environment or use default
  const modelId = process.env.SUMMARIZATION_MODEL || DEFAULT_MODEL;

  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: "user",
          content: buildSummarizationPrompt(content),
        },
      ],
    });

    // Extract text from response
    const textContent = response.content.find((block) => block.type === "text");
    const responseText = textContent?.type === "text" ? textContent.text : "";

    if (!responseText) {
      throw new Error("Empty response from Anthropic API");
    }

    // Extract summary from <summary> tags
    const summary = extractSummaryFromResponse(responseText);

    return {
      summary,
      modelId,
    };
  } catch (error) {
    logger.error("Anthropic API call failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Checks if summarization is available.
 *
 * @returns true if ANTHROPIC_API_KEY is set
 */
export function isSummarizationAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Gets the model ID for summarization.
 */
export function getSummarizationModelId(): string {
  return process.env.SUMMARIZATION_MODEL || DEFAULT_MODEL;
}
