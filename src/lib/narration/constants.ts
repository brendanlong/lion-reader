/**
 * Shared constants for narration/TTS functionality.
 *
 * @module narration/constants
 */

/**
 * The narration format: bump this whenever the walk in `./runs` changes what it
 * says, or anything upstream of it changes which elements get numbered — the
 * numbering in `./block-elements` or the tree it walks (`./parse-html`).
 *
 * A cached narration is stored with the paragraph map built at generation time,
 * and those element numbers only mean anything against the numbering the format
 * produced. Serving an older row against today's `data-para-id`s would
 * highlight the wrong paragraphs, so this is part of the `narration_content`
 * cache key: a bump misses the cache instead, and two releases that disagree
 * about the numbering never share a row.
 */
export const NARRATION_FORMAT_VERSION = 4;

/**
 * Providers selectable for narration preprocessing. Narration preprocessing
 * only supports the OpenAI-compatible providers — it relies on JSON-object
 * response formatting. This is also the preference order for the default model
 * when the user hasn't picked one: Cerebras first (fastest), then Groq, then
 * OpenRouter (an extra hop).
 */
export const NARRATION_PROVIDERS = ["cerebras", "groq", "openrouter"] as const;

export type NarrationProvider = (typeof NARRATION_PROVIDERS)[number];

export function isNarrationProvider(provider: string): provider is NarrationProvider {
  return (NARRATION_PROVIDERS as readonly string[]).includes(provider);
}

/**
 * Default narration preprocessing model per provider, as `provider:model`
 * references. The effective default is the first configured provider's entry,
 * in {@link NARRATION_PROVIDERS} order.
 */
export const DEFAULT_NARRATION_MODELS: Record<NarrationProvider, string> = {
  cerebras: "cerebras:gpt-oss-120b",
  groq: "groq:openai/gpt-oss-120b",
  openrouter: "openrouter:openai/gpt-oss-120b",
};

/**
 * Models listed first in the narration processing picker (when their provider
 * is configured). Every provider's default is also suggested.
 */
export const SUGGESTED_NARRATION_MODELS: string[] = [
  ...NARRATION_PROVIDERS.map((provider) => DEFAULT_NARRATION_MODELS[provider]),
  "openrouter:openai/gpt-oss-20b",
  "openrouter:~google/gemini-flash-latest",
];

/**
 * Default model for LLM narration preprocessing when no provider is known to be
 * configured (e.g. as a frontend fallback before the models query resolves).
 */
export const DEFAULT_NARRATION_MODEL = DEFAULT_NARRATION_MODELS.cerebras;

/**
 * Cloud voices (server-side TTS through DeepInfra or OpenRouter). Kokoro is the
 * default: good quality at about a cent per long article.
 */
export const DEEPINFRA_KOKORO = "deepinfra:hexgrad/Kokoro-82M";
export const OPENROUTER_KOKORO = "openrouter:hexgrad/kokoro-82m";

/**
 * The default cloud voice model, in preference order: the first one the user
 * can use (its provider has a key). DeepInfra directly is several times faster
 * than OpenRouter, whose speech endpoint adds seconds to every request.
 */
export const DEFAULT_CLOUD_VOICE_MODELS: string[] = [DEEPINFRA_KOKORO, OPENROUTER_KOKORO];

/** The default model before the server has said which ones are available. */
export const DEFAULT_CLOUD_VOICE_MODEL = DEFAULT_CLOUD_VOICE_MODELS[0];

/**
 * Voice used when the user hasn't picked one; models not listed here use the
 * first voice they report.
 */
export const DEFAULT_CLOUD_VOICES: Record<string, string> = {
  [DEEPINFRA_KOKORO]: "af_heart",
  [OPENROUTER_KOKORO]: "af_heart",
  "openrouter:mistralai/voxtral-mini-tts-2603": "en_paul_neutral",
  "openrouter:deepgram/aura-2": "aura-2-thalia-en",
};

/** Speech models listed first in the picker. */
export const SUGGESTED_CLOUD_VOICE_MODELS: string[] = [
  ...DEFAULT_CLOUD_VOICE_MODELS,
  "openrouter:mistralai/voxtral-mini-tts-2603",
  "openrouter:deepgram/aura-2",
];

/**
 * The only speech models usable on the server's keys; the others cost 4–50x
 * more per character, so they need the user's own key for that provider.
 */
export const SERVER_KEY_CLOUD_VOICE_MODELS: string[] = [DEEPINFRA_KOKORO, OPENROUTER_KOKORO];

/**
 * Longest text synthesized per request. Paragraphs are split into chunks of
 * at most this size so playback can start (and skip) without waiting for a
 * whole long paragraph.
 */
export const MAX_CLOUD_SPEECH_CHARS = 1000;

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
