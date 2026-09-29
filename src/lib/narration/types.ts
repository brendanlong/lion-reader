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
 * Options for the speak() method.
 */
export interface SpeakOptions {
  /**
   * The voice ID to use for speaking.
   *
   * If not provided or not found, the provider's default voice is used.
   */
  voiceId?: string;

  /**
   * Speech rate multiplier (0.5 to 2.0).
   * Default: 1.0
   */
  rate?: number;

  /**
   * Called when speech starts.
   */
  onStart?: () => void;

  /**
   * Called when speech ends naturally (not when stopped/cancelled).
   */
  onEnd?: () => void;

  /**
   * Called when an error occurs during speech.
   *
   * @param error - The error that occurred.
   */
  onError?: (error: Error) => void;
}
