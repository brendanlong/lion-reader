/**
 * Summarization service for AI-powered article summaries.
 *
 * Uses a configurable AI provider (Anthropic, Groq, or Cerebras) to generate
 * concise summaries of articles. Summaries are cached by content hash for
 * deduplication across entries.
 */

import { createHash } from "crypto";
import { marked } from "marked";
import { logger } from "@/lib/logger";
import { sanitizeEntryHtml } from "@/server/html/sanitize";
import { htmlToPlainText } from "@/lib/narration/html-to-narration-input";
import { parseModelRef } from "@/lib/ai/model-ref";
import {
  generateChatCompletion,
  getAvailableProviders,
  type AiProviderKeys,
} from "@/server/services/ai-providers";
import {
  DEFAULT_SUMMARIZATION_MODELS,
  SUMMARIZATION_PROVIDER_PRIORITY,
  DEFAULT_SUMMARIZATION_MAX_WORDS,
} from "@/lib/summarization/constants";

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
 * Maximum content length to send to the LLM (in characters).
 * ~50,000 characters is roughly 12,500 tokens.
 */
const MAX_CONTENT_LENGTH = 50000;

/**
 * Maximum tokens for the summary response.
 *
 * The OpenAI-compatible providers get a higher cap because reasoning models
 * (gpt-oss) spend part of the completion budget on reasoning tokens before
 * emitting the summary; a 1024 cap can truncate mid-reasoning.
 */
const MAX_OUTPUT_TOKENS_ANTHROPIC = 1024;
const MAX_OUTPUT_TOKENS_OPENAI_COMPAT = 4096;

/**
 * Gets the configured max words for summaries.
 * Priority: user setting > environment variable > default.
 */
export function getMaxWords(userMaxWords?: number | null): number {
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
  return DEFAULT_SUMMARIZATION_MAX_WORDS;
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
export function buildSummarizationPrompt(
  content: string,
  title: string,
  options?: { userMaxWords?: number | null; userPrompt?: string | null }
): string {
  const maxWords = getMaxWords(options?.userMaxWords);
  const template = options?.userPrompt || DEFAULT_SUMMARIZATION_PROMPT;

  // Single pass with a function replacement, NOT sequential string replaceAll:
  // string replacements interpret `$&`, `` $` ``, `$'` etc. in the replacement,
  // so article content containing `$` patterns would splice in template
  // fragments. A single regex pass also prevents content substituted for one
  // placeholder from injecting into a later placeholder's slot.
  const substitutions: Record<string, string> = {
    "{{content}}": content,
    "{{title}}": title,
    "{{maxWords}}": String(maxWords),
  };
  return template.replaceAll(
    /\{\{(?:content|title|maxWords)\}\}/g,
    (match) => substitutions[match]
  );
}

/**
 * Hashes the effective summarization prompt so cached summaries can detect when
 * the user changes their custom prompt (or clears it back to the default).
 * Falls back to the default template when the user has no custom prompt, so a
 * custom prompt that matches the default hashes the same as no custom prompt.
 */
export function hashPrompt(userPrompt?: string | null): string {
  const template = userPrompt || DEFAULT_SUMMARIZATION_PROMPT;
  return createHash("sha256").update(template, "utf8").digest("hex");
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
 * Generates a summary using the model's provider (Anthropic, Groq, or
 * Cerebras).
 *
 * @param content - Plain text content to summarize
 * @returns The generated summary and model ID
 * @throws Error if the provider API call fails
 *
 * @example
 * try {
 *   const result = await generateSummary("Long article text here...", "Title", { keys });
 *   console.log(result.summary);
 * } catch (error) {
 *   console.error('Summarization failed:', error);
 * }
 */
export async function generateSummary(
  content: string,
  title: string,
  options?: {
    keys?: AiProviderKeys;
    userModel?: string | null;
    userMaxWords?: number | null;
    userPrompt?: string | null;
  }
): Promise<GenerateSummaryResult> {
  // Priority: user model > environment > default
  const modelId = getSummarizationModelId(options?.userModel, options?.keys);
  const modelRef = parseModelRef(modelId);

  try {
    const responseText = await generateChatCompletion(modelRef, options?.keys, {
      userPrompt: buildSummarizationPrompt(content, title, {
        userMaxWords: options?.userMaxWords,
        userPrompt: options?.userPrompt,
      }),
      maxTokens:
        modelRef.provider === "anthropic"
          ? MAX_OUTPUT_TOKENS_ANTHROPIC
          : MAX_OUTPUT_TOKENS_OPENAI_COMPAT,
      ...(modelRef.provider !== "anthropic" ? { reasoningEffort: "medium" as const } : {}),
    });

    if (!responseText) {
      throw new Error("Empty response from summarization model");
    }

    // Extract summary from <summary> tags and convert Markdown to HTML.
    // marked passes raw HTML through, and the summary is rendered via
    // dangerouslySetInnerHTML, so sanitize before storing/returning it.
    const markdownSummary = extractSummaryFromResponse(responseText);
    const summary = sanitizeEntryHtml(await marked.parse(markdownSummary)) ?? "";

    return {
      summary,
      modelId,
    };
  } catch (error) {
    logger.error("Summarization API call failed", {
      provider: modelRef.provider,
      model: modelRef.model,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Checks if summarization is available (any provider has a user or server
 * key configured).
 */
export function isSummarizationAvailable(keys?: AiProviderKeys): boolean {
  return getAvailableProviders(keys).length > 0;
}

/**
 * Gets the model ID for summarization as a `provider:model` reference
 * (legacy stored values may be bare Anthropic IDs — parse with
 * `parseModelRef`).
 *
 * Priority: user setting > `SUMMARIZATION_MODEL` env var > the default model
 * of the first configured provider (Cerebras, then Groq, then Anthropic).
 */
export function getSummarizationModelId(userModel?: string | null, keys?: AiProviderKeys): string {
  if (userModel) {
    return userModel;
  }
  if (process.env.SUMMARIZATION_MODEL) {
    return process.env.SUMMARIZATION_MODEL;
  }
  const available = getAvailableProviders(keys);
  // When nothing is configured summarization is disabled anyway, so the value
  // is nominal — fall back to the highest-priority provider's default.
  const provider =
    SUMMARIZATION_PROVIDER_PRIORITY.find((p) => available.includes(p)) ??
    SUMMARIZATION_PROVIDER_PRIORITY[0];
  return DEFAULT_SUMMARIZATION_MODELS[provider];
}
