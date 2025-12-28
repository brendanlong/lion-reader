/**
 * TTS Provider Abstraction Types
 *
 * This module defines the interfaces for a unified TTS provider system
 * that supports multiple backends (browser Web Speech API, Piper, etc.)
 * while providing a consistent API for the application.
 *
 * @module narration/types
 */

/**
 * Provider identifier for TTS backends.
 */
export type TTSProviderId = "browser" | "piper";

/**
 * Unified interface for TTS providers.
 *
 * Implementations of this interface wrap different TTS backends
 * (Web Speech API, Piper, etc.) behind a common API.
 */
export interface TTSProvider {
  /**
   * Unique identifier for this provider.
   */
  readonly id: TTSProviderId;

  /**
   * Human-readable name for display in UI.
   */
  readonly name: string;

  /**
   * Checks if this provider is available in the current environment.
   *
   * For browser TTS, this checks for Web Speech API support.
   * For Piper, this checks for WebAssembly and IndexedDB support.
   *
   * @returns true if the provider can be used, false otherwise.
   */
  isAvailable(): boolean;

  /**
   * Gets the list of available voices for this provider.
   *
   * @returns Promise resolving to array of available voices.
   */
  getVoices(): Promise<TTSVoice[]>;

  /**
   * Speaks the given text using the specified options.
   *
   * @param text - The text to speak.
   * @param options - Speaking options including voice, rate, pitch, and callbacks.
   * @returns Promise that resolves when speech starts (not when it ends).
   */
  speak(text: string, options: SpeakOptions): Promise<void>;

  /**
   * Stops any current speech immediately.
   */
  stop(): void;

  /**
   * Pauses current speech.
   *
   * Note: Not all providers support pause/resume.
   * If unsupported, this may behave like stop().
   */
  pause(): void;

  /**
   * Resumes paused speech.
   *
   * Note: Not all providers support pause/resume.
   * If unsupported, this may restart from the beginning.
   */
  resume(): void;
}

/**
 * Unified voice representation across all TTS providers.
 */
export interface TTSVoice {
  /**
   * Unique identifier for this voice.
   *
   * For browser voices, this is the voiceURI.
   * For Piper voices, this is the model ID (e.g., "en_US-lessac-medium").
   */
  id: string;

  /**
   * Human-readable display name.
   */
  name: string;

  /**
   * Language code (e.g., "en-US", "en-GB").
   */
  language: string;

  /**
   * Which provider this voice belongs to.
   */
  provider: TTSProviderId;

  /**
   * For downloadable voices (Piper): current download status.
   * Browser voices are always considered "downloaded".
   */
  downloadStatus?: "not-downloaded" | "downloading" | "downloaded";

  /**
   * For downloading voices: progress from 0 to 100.
   */
  downloadProgress?: number;
}

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
   * Speech pitch multiplier (0.5 to 2.0).
   * Default: 1.0
   */
  pitch?: number;

  /**
   * Called when speech starts.
   */
  onStart?: () => void;

  /**
   * Called when speech ends naturally (not when stopped/cancelled).
   */
  onEnd?: () => void;

  /**
   * Called when moving to a new paragraph.
   * Only applicable when speaking multiple paragraphs.
   *
   * @param index - The index of the paragraph being spoken.
   */
  onParagraph?: (index: number) => void;

  /**
   * Called when an error occurs during speech.
   *
   * @param error - The error that occurred.
   */
  onError?: (error: Error) => void;
}
