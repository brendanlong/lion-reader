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
export const CURRENT_PROMPT_VERSION = 1;

/**
 * Default model for summarization.
 */
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

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
 * System prompt for summarization.
 */
const SUMMARIZATION_SYSTEM_PROMPT = `You are an expert summarizer. Create concise, informative summaries of articles.

Rules:
- Write 2-3 short paragraphs summarizing the key points
- Focus on the main topic, key findings, and important conclusions
- Be factual and objective - do not add opinions or commentary
- Write in a direct, informative style
- Do NOT use phrases like "This article discusses" or "The author argues"
- Do NOT use bullet points or lists
- If the content is too short or lacks substance, provide a brief summary of what's there

Return ONLY the summary text, nothing else.`;

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
      system: SUMMARIZATION_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Please summarize this article:\n\n${content}`,
        },
      ],
    });

    // Extract text from response
    const textContent = response.content.find((block) => block.type === "text");
    const summary = textContent?.type === "text" ? textContent.text : "";

    if (!summary) {
      throw new Error("Empty response from Anthropic API");
    }

    return {
      summary: summary.trim(),
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
