/**
 * Provider-qualified AI model references.
 *
 * Models are stored and transmitted as `provider:model` strings (e.g.
 * `anthropic:claude-sonnet-5`, `groq:openai/gpt-oss-20b`,
 * `cerebras:gpt-oss-120b`) so a single setting can select a model from any
 * configured provider. Legacy values without a provider prefix (bare Anthropic
 * model IDs like `claude-sonnet-4-5`, stored before multi-provider support)
 * parse as Anthropic models.
 *
 * Shared between server services and the settings UI.
 */

/**
 * Supported AI providers.
 */
export const AI_PROVIDERS = ["anthropic", "groq", "cerebras"] as const;

export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * Human-readable provider names for the settings UI.
 */
export const AI_PROVIDER_DISPLAY_NAMES: Record<AiProvider, string> = {
  anthropic: "Anthropic",
  groq: "Groq",
  cerebras: "Cerebras",
};

/**
 * A model reference resolved to its provider and provider-native model ID.
 */
export interface ModelRef {
  provider: AiProvider;
  /** The provider-native model ID (no provider prefix). */
  model: string;
}

function isAiProvider(value: string): value is AiProvider {
  return (AI_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Parses a `provider:model` reference. Bare model IDs (no known provider
 * prefix) are treated as Anthropic models for backward compatibility with
 * settings stored before multi-provider support.
 */
export function parseModelRef(ref: string): ModelRef {
  const colonIndex = ref.indexOf(":");
  if (colonIndex > 0) {
    const prefix = ref.slice(0, colonIndex);
    if (isAiProvider(prefix)) {
      return { provider: prefix, model: ref.slice(colonIndex + 1) };
    }
  }
  return { provider: "anthropic", model: ref };
}

/**
 * Formats a provider + provider-native model ID as a `provider:model` string.
 */
export function formatModelRef(provider: AiProvider, model: string): string {
  return `${provider}:${model}`;
}

/**
 * Normalizes a stored model value to its `provider:model` form so values
 * written before multi-provider support (bare Anthropic IDs) compare equal to
 * their prefixed equivalents.
 */
export function normalizeModelRef(model: string): string {
  const ref = parseModelRef(model);
  return formatModelRef(ref.provider, ref.model);
}
