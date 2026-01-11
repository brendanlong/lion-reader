/**
 * Shared constants for narration/TTS functionality.
 *
 * @module narration/constants
 */

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
