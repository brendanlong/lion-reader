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

/**
 * Where narration is, across every provider. `generating` is producing the
 * narration text before the player has anything to play; `buffering` is a
 * player with paragraphs waiting on audio (its first chunk, or the next one
 * mid-playback), so it's controllable while `generating` is not.
 */
export type NarrationStatus = "idle" | "generating" | "buffering" | "playing" | "paused";
