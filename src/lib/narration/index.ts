/**
 * Narration utilities for Lion Reader.
 *
 * This module provides utilities for text-to-speech narration of articles:
 * - Voice selection and management
 * - Feature detection for browser APIs
 *
 * @module narration
 */

// Voice selection utilities
export { getAvailableVoices, waitForVoices, rankVoices, findVoiceByUri } from "./voices";

// Feature detection utilities
export {
  isNarrationSupported,
  isMediaSessionSupported,
  getNarrationSupportInfo,
  type NarrationSupportInfo,
} from "./feature-detection";
