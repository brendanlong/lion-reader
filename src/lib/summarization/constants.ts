/**
 * Shared constants for summarization functionality.
 *
 * These are used by both the server service and frontend settings UI.
 */

import type { AiProvider } from "@/lib/ai/model-ref";

/**
 * Default summarization model per provider, as `provider:model` references.
 * The effective default is the first configured provider's entry, in
 * {@link SUMMARIZATION_PROVIDER_PRIORITY} order.
 */
export const DEFAULT_SUMMARIZATION_MODELS: Record<AiProvider, string> = {
  anthropic: "anthropic:claude-sonnet-5",
  groq: "groq:openai/gpt-oss-120b",
  cerebras: "cerebras:gpt-oss-120b",
  openrouter: "openrouter:openai/gpt-oss-120b",
};

/**
 * Provider preference order for the default summarization model when the user
 * hasn't picked one. Cerebras and Groq run gpt-oss far faster than Anthropic,
 * and most users prefer the fastest possible summaries over minor quality
 * gains, so the hosted OpenAI-compatible providers come first. OpenRouter
 * routes gpt-oss to the fastest host it has, but adds a hop.
 */
export const SUMMARIZATION_PROVIDER_PRIORITY: AiProvider[] = [
  "cerebras",
  "groq",
  "openrouter",
  "anthropic",
];

/**
 * Models listed first in the summarization picker (when their provider is
 * configured), so the long OpenRouter catalog has sane starting points.
 * Every provider's default is also suggested.
 */
export const SUGGESTED_SUMMARIZATION_MODELS: string[] = [
  ...SUMMARIZATION_PROVIDER_PRIORITY.map((provider) => DEFAULT_SUMMARIZATION_MODELS[provider]),
  "openrouter:~google/gemini-flash-latest",
  "openrouter:~anthropic/claude-sonnet-latest",
  "openrouter:~deepseek/deepseek-v4-flash-latest",
];

/**
 * Default summarization model when no provider is known to be configured
 * (e.g. as a frontend fallback before the models query resolves).
 */
export const DEFAULT_SUMMARIZATION_MODEL = DEFAULT_SUMMARIZATION_MODELS.cerebras;

/**
 * Default maximum words for generated summaries.
 */
export const DEFAULT_SUMMARIZATION_MAX_WORDS = 150;
