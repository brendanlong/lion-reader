/**
 * Summarization service for AI-powered article summaries.
 *
 * Uses Anthropic Claude to generate concise summaries of articles.
 * Summaries are cached by content hash for deduplication across entries.
 */

import Anthropic from "@anthropic-ai/sdk";
import { marked } from "marked";
import { logger } from "@/lib/logger";
import { htmlToPlainText } from "@/lib/narration/html-to-narration-input";

// Configure marked for safe rendering
marked.setOptions({
  gfm: true, // GitHub Flavored Markdown
  breaks: true, // Convert \n to <br>
});

/**
 * Current prompt version. Increment this when changing the prompt
 * to invalidate cached summaries.
 */
export const CURRENT_PROMPT_VERSION = 3;

/**
 * Default model for summarization.
 */
const DEFAULT_MODEL = "claude-sonnet-4-5";

/**
 * Default maximum words for summaries.
 */
const DEFAULT_MAX_WORDS = 150;

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
 * Priority: user setting > environment variable > default.
 */
function getMaxWords(userMaxWords?: number | null): number {
  if (userMaxWords && userMaxWords > 0) {
    return userMaxWords;
  }
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
 * The default summarization prompt template.
 * Exported for use in the frontend as a placeholder/default.
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `You will be summarizing content from a blog post or web page for display in an RSS reader app. Your goal is to create a concise, informative summary that captures the main points and helps readers quickly understand what the content is about.

Here is the content to summarize:

<content>
{{content}}
</content>

Your summary should be no longer than {{maxWords}} words.

Please follow these guidelines when creating your summary:

- Focus on the main topic, key points, and most important takeaways from the content
- Include any significant conclusions, findings, or recommendations if present
- Maintain a neutral, informative tone
- Avoid including minor details, tangential information, or excessive examples
- Do not include your own opinions or commentary
- If the content contains multiple distinct sections or topics, briefly mention each main topic
- Write in clear, straightforward language that is easy to scan quickly
- Ensure the summary is self-contained and understandable without needing to read the full content
- Format your summary using Markdown for better readability (use bullet points, bold text, etc. where appropriate)
- Don't include a title (the article already has one: {{title}})

Your summary must not exceed {{maxWords}} words. If the content is very short and already concise, your summary may be shorter than the maximum length.

Write your summary inside <summary> tags.`;

/**
 * Builds the user prompt for summarization.
 * Uses the user's custom prompt if provided, otherwise falls back to the default.
 * Template variables: {{content}}, {{title}}, {{maxWords}}
 */
function buildSummarizationPrompt(
  content: string,
  title: string,
  options?: { userMaxWords?: number | null; userPrompt?: string | null }
): string {
  const maxWords = getMaxWords(options?.userMaxWords);
  const template = options?.userPrompt || DEFAULT_SUMMARIZATION_PROMPT;

  return template
    .replaceAll("{{content}}", content)
    .replaceAll("{{title}}", title)
    .replaceAll("{{maxWords}}", String(maxWords));
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
 * Global Anthropic client instance. Only initialized when ANTHROPIC_API_KEY env var is set.
 */
let globalAnthropicClient: Anthropic | null = null;

/**
 * Gets or creates an Anthropic client instance.
 * If a user API key is provided, creates a new client with that key.
 * Otherwise falls back to the global client using ANTHROPIC_API_KEY env var.
 * Returns null if no API key is available.
 */
function getAnthropicClient(userApiKey?: string | null): Anthropic | null {
  if (userApiKey) {
    return new Anthropic({ apiKey: userApiKey });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return null;
  }

  if (!globalAnthropicClient) {
    globalAnthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  return globalAnthropicClient;
}

/**
 * Result of summary generation.
 */
export interface GenerateSummaryResult {
  /** The generated summary as HTML (converted from Markdown) */
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
export async function generateSummary(
  content: string,
  title: string,
  options?: {
    userApiKey?: string | null;
    userModel?: string | null;
    userMaxWords?: number | null;
    userPrompt?: string | null;
  }
): Promise<GenerateSummaryResult> {
  const client = getAnthropicClient(options?.userApiKey);

  if (!client) {
    throw new Error("Anthropic API key not configured");
  }

  // Priority: user model > environment > default
  const modelId = options?.userModel || process.env.SUMMARIZATION_MODEL || DEFAULT_MODEL;

  try {
    const response = await client.messages.create({
      model: modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [
        {
          role: "user",
          content: buildSummarizationPrompt(content, title, {
            userMaxWords: options?.userMaxWords,
            userPrompt: options?.userPrompt,
          }),
        },
      ],
    });

    // Extract text from response
    const textContent = response.content.find((block) => block.type === "text");
    const responseText = textContent?.type === "text" ? textContent.text : "";

    if (!responseText) {
      throw new Error("Empty response from Anthropic API");
    }

    // Extract summary from <summary> tags and convert Markdown to HTML
    const markdownSummary = extractSummaryFromResponse(responseText);
    const summary = await marked.parse(markdownSummary);

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
 * @param userApiKey - Optional user-configured API key
 * @returns true if either the user API key or ANTHROPIC_API_KEY env var is set
 */
export function isSummarizationAvailable(userApiKey?: string | null): boolean {
  return !!userApiKey || !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Gets the model ID for summarization.
 *
 * @param userModel - Optional user-configured model
 */
export function getSummarizationModelId(userModel?: string | null): string {
  return userModel || process.env.SUMMARIZATION_MODEL || DEFAULT_MODEL;
}

/**
 * Model info returned from the list models API.
 */
export interface SummarizationModel {
  id: string;
  displayName: string;
}

/**
 * Strips date suffixes from versioned model IDs, keeping only the first
 * (newest) version of each model.
 *
 * The Anthropic API returns versioned IDs like "claude-sonnet-4-5-20250929"
 * but accepts shorter aliases like "claude-sonnet-4-5". Since the API returns
 * models newest-first, we keep the first occurrence of each alias and drop
 * subsequent versions.
 */
export function simplifyModelIds(models: SummarizationModel[]): SummarizationModel[] {
  const seen = new Set<string>();
  const result: SummarizationModel[] = [];

  for (const model of models) {
    const match = model.id.match(/^(.+)-\d{8}$/);
    const alias = match ? match[1] : model.id;

    if (!seen.has(alias)) {
      seen.add(alias);
      result.push({ id: alias, displayName: model.displayName });
    }
  }

  return result;
}

/**
 * Lists available Anthropic models.
 *
 * @param userApiKey - Optional user-configured API key
 * @returns Array of available models with alias entries added
 */
export async function listModels(userApiKey?: string | null): Promise<SummarizationModel[]> {
  const client = getAnthropicClient(userApiKey);

  if (!client) {
    return [];
  }

  try {
    const models: SummarizationModel[] = [];
    // Fetch all models using auto-pagination
    for await (const model of client.models.list({ limit: 100 })) {
      models.push({
        id: model.id,
        displayName: model.display_name,
      });
    }
    return simplifyModelIds(models);
  } catch (error) {
    logger.error("Failed to list Anthropic models", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}
