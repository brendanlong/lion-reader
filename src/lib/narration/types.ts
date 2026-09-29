/**
 * Shared narration types.
 *
 * @module narration/types
 */

/**
 * TTS backends: the browser's Web Speech API, Piper running in the browser
 * ("Enhanced Voices"), and server-side speech models ("Cloud Voices").
 */
export const TTS_PROVIDER_IDS = ["browser", "piper", "cloud"] as const;

export type TTSProviderId = (typeof TTS_PROVIDER_IDS)[number];
