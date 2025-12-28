/**
 * Enhanced voice definitions for Piper TTS.
 *
 * This module provides a curated list of high-quality Piper voices
 * with metadata for display in the UI.
 *
 * @module narration/enhanced-voices
 */

/**
 * Represents an enhanced voice available for download.
 *
 * Enhanced voices are high-quality Piper TTS voices that can be
 * downloaded and used offline.
 */
export interface EnhancedVoice {
  /**
   * Unique identifier for the voice model.
   * Matches the Piper voice file naming convention (e.g., "en_US-lessac-medium").
   */
  id: string;

  /**
   * Human-readable name for display in the UI (e.g., "Alex (US)").
   */
  displayName: string;

  /**
   * Short description of the voice characteristics.
   */
  description: string;

  /**
   * Language code in BCP 47 format (e.g., "en-US", "en-GB").
   */
  language: string;

  /**
   * Voice gender.
   */
  gender: "male" | "female";

  /**
   * Quality level of the voice model.
   * Higher quality means larger file size and better audio.
   */
  quality: "low" | "medium" | "high";

  /**
   * Approximate size of the voice model in bytes.
   * Used for displaying download size to users.
   */
  sizeBytes: number;

  /**
   * Optional URL to a sample audio file for preview.
   */
  sampleUrl?: string;
}

/**
 * Curated list of enhanced voices available for download.
 *
 * These voices were selected for:
 * - High quality audio output
 * - Variety of accents (US, UK, AU)
 * - Mix of male and female voices
 * - Reasonable download sizes
 */
export const ENHANCED_VOICES: readonly EnhancedVoice[] = [
  {
    id: "en_US-lessac-medium",
    displayName: "Alex (US)",
    description: "Clear, natural American voice",
    language: "en-US",
    gender: "female",
    quality: "medium",
    sizeBytes: 50 * 1024 * 1024, // ~50 MB
  },
  {
    id: "en_US-amy-low",
    displayName: "Amy (US)",
    description: "Fast, smaller download",
    language: "en-US",
    gender: "female",
    quality: "low",
    sizeBytes: 17 * 1024 * 1024, // ~17 MB
  },
  {
    id: "en_US-ryan-medium",
    displayName: "Ryan (US)",
    description: "Natural male American voice",
    language: "en-US",
    gender: "male",
    quality: "medium",
    sizeBytes: 50 * 1024 * 1024, // ~50 MB
  },
  {
    id: "en_GB-alba-medium",
    displayName: "Alba (UK)",
    description: "British accent",
    language: "en-GB",
    gender: "female",
    quality: "medium",
    sizeBytes: 50 * 1024 * 1024, // ~50 MB
  },
  {
    id: "en_AU-karen-medium",
    displayName: "Karen (AU)",
    description: "Australian accent",
    language: "en-AU",
    gender: "female",
    quality: "medium",
    sizeBytes: 50 * 1024 * 1024, // ~50 MB
  },
] as const;

/**
 * Finds an enhanced voice by its ID.
 *
 * @param voiceId - The voice ID to search for.
 * @returns The enhanced voice if found, undefined otherwise.
 *
 * @example
 * ```ts
 * const voice = findEnhancedVoice("en_US-lessac-medium");
 * if (voice) {
 *   console.log(voice.displayName); // "Alex (US)"
 * }
 * ```
 */
export function findEnhancedVoice(voiceId: string): EnhancedVoice | undefined {
  return ENHANCED_VOICES.find((v) => v.id === voiceId);
}

/**
 * Checks if a voice ID is a valid enhanced voice.
 *
 * @param voiceId - The voice ID to check.
 * @returns true if the voice ID is in the ENHANCED_VOICES list.
 *
 * @example
 * ```ts
 * if (isEnhancedVoice("en_US-lessac-medium")) {
 *   // This is an enhanced voice that can be downloaded
 * }
 * ```
 */
export function isEnhancedVoice(voiceId: string): boolean {
  return ENHANCED_VOICES.some((v) => v.id === voiceId);
}
