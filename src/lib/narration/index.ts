/**
 * Narration utilities for Lion Reader.
 *
 * This module provides utilities for text-to-speech narration of articles:
 * - TTS provider abstraction for multiple backends (browser, Piper, etc.)
 * - Voice selection and management
 * - Feature detection for browser APIs
 * - Voice caching for offline use
 *
 * @module narration
 */

// TTS Provider types
export type { TTSProvider, TTSVoice, SpeakOptions, TTSProviderId } from "./types";

// TTS Provider implementations
export { BrowserTTSProvider, getBrowserTTSProvider } from "./browser-tts-provider";
export {
  PiperTTSProvider,
  getPiperTTSProvider,
  VoiceNotDownloadedError,
} from "./piper-tts-provider";

// Voice selection utilities
export { getAvailableVoices, waitForVoices, rankVoices, findVoiceByUri } from "./voices";

// Feature detection utilities
export {
  isNarrationSupported,
  isMediaSessionSupported,
  getNarrationSupportInfo,
  type NarrationSupportInfo,
} from "./feature-detection";

// Voice caching
export { VoiceCache, STORAGE_LIMIT_BYTES, type VoiceCacheEntry } from "./voice-cache";

// Enhanced voices (Piper TTS)
export {
  ENHANCED_VOICES,
  findEnhancedVoice,
  isEnhancedVoice,
  type EnhancedVoice,
} from "./enhanced-voices";

// Voice download manager
export {
  downloadVoice,
  isVoiceDownloaded,
  deleteDownloadedVoice,
  getDownloadedVoices,
  getVoiceDownloadUrls,
  fetchWithProgress,
  VoiceDownloadError,
  type ProgressCallback,
  type VoiceDownloadUrls,
} from "./voice-download";
