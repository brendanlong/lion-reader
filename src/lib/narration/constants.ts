/**
 * Shared constants for narration/TTS functionality.
 *
 * @module narration/constants
 */

/**
 * Providers selectable for narration preprocessing. Narration preprocessing
 * only supports the OpenAI-compatible providers (Groq, Cerebras) — it relies
 * on JSON-object response formatting. This is also the preference order for the
 * default model when the user hasn't picked one: Cerebras first (fastest), then
 * Groq.
 */
export const NARRATION_PROVIDERS = ["cerebras", "groq"] as const;

export type NarrationProvider = (typeof NARRATION_PROVIDERS)[number];

/**
 * Default narration preprocessing model per provider, as `provider:model`
 * references. The effective default is the first configured provider's entry,
 * in {@link NARRATION_PROVIDERS} order.
 */
export const DEFAULT_NARRATION_MODELS: Record<NarrationProvider, string> = {
  cerebras: "cerebras:gpt-oss-120b",
  groq: "groq:openai/gpt-oss-120b",
};

/**
 * Default model for LLM narration preprocessing when no provider is known to be
 * configured (e.g. as a frontend fallback before the models query resolves).
 */
export const DEFAULT_NARRATION_MODEL = DEFAULT_NARRATION_MODELS.cerebras;

/**
 * Default speech rate (1.0 = normal speed).
 */
export const DEFAULT_RATE = 1.0;

/**
 * Default speech pitch (1.0 = normal pitch).
 */
export const DEFAULT_PITCH = 1.0;

/**
 * Minimum allowed rate value.
 */
export const MIN_RATE = 0.5;

/**
 * Maximum allowed rate value.
 */
export const MAX_RATE = 2.0;

/**
 * Minimum allowed pitch value.
 */
export const MIN_PITCH = 0.5;

/**
 * Maximum allowed pitch value.
 */
export const MAX_PITCH = 2.0;

/**
 * Preview text used for voice demos.
 */
export const PREVIEW_TEXT = "This is a preview of how articles will sound with this voice.";

/**
 * Clamps a value between a minimum and maximum.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
