/**
 * Piper TTS Provider
 *
 * Implements the TTSProvider interface using Piper TTS via WebAssembly.
 * This provider offers high-quality neural text-to-speech that runs
 * entirely in the browser.
 *
 * @module narration/piper-tts-provider
 */

import type { TTSProvider, TTSVoice, SpeakOptions } from "./types";
import { ENHANCED_VOICES, findEnhancedVoice } from "./enhanced-voices";

/**
 * Dynamically imports the piper-tts-web module.
 * This allows for code splitting and lazy loading.
 */
async function getPiperTTS(): Promise<typeof import("@mintplex-labs/piper-tts-web")> {
  return import("@mintplex-labs/piper-tts-web");
}

/**
 * Custom WASM paths configuration.
 * We serve ONNX WASM files locally because the default CDN URL is broken.
 * Piper WASM files are served from jsdelivr which works correctly.
 */
const CUSTOM_WASM_PATHS = {
  // Serve ONNX WASM from our public folder (the default cdnjs URL returns 404)
  onnxWasm: "/onnx/",
  // These work from the default CDN
  piperData:
    "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.data",
  piperWasm:
    "https://cdn.jsdelivr.net/npm/@diffusionstudio/piper-wasm@1.0.0/build/piper_phonemize.wasm",
};

/**
 * Default speech rate (1.0 = normal speed).
 */
const DEFAULT_RATE = 1.0;

/**
 * Minimum allowed rate value.
 */
const MIN_RATE = 0.5;

/**
 * Maximum allowed rate value.
 */
const MAX_RATE = 2.0;

/**
 * Clamps a value between a minimum and maximum.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Error thrown when a voice is not downloaded.
 */
export class VoiceNotDownloadedError extends Error {
  constructor(public readonly voiceId: string) {
    super(`Voice "${voiceId}" is not downloaded. Please download it first using downloadVoice().`);
    this.name = "VoiceNotDownloadedError";
  }
}

/**
 * PiperTTSProvider implements TTSProvider using Piper TTS via WebAssembly.
 *
 * This provider offers high-quality neural text-to-speech with:
 * - Natural sounding voices
 * - Offline capability (after voice download)
 * - Consistent quality across browsers
 *
 * Limitations:
 * - Requires voice model download (~17-50 MB per voice)
 * - Initial synthesis may be slow (WASM initialization)
 * - No real-time pause/resume (must restart from beginning)
 */
export class PiperTTSProvider implements TTSProvider {
  readonly id = "piper" as const;
  readonly name = "Enhanced Voices";

  private audioContext: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;
  private currentOptions: SpeakOptions | null = null;
  private isPaused = false;
  private pausedAt = 0;
  private startedAt = 0;
  private currentBuffer: AudioBuffer | null = null;

  /**
   * Checks if Piper TTS is available in the current environment.
   *
   * Requires:
   * - AudioContext for audio playback
   * - Origin Private File System for model storage (via navigator.storage)
   */
  isAvailable(): boolean {
    if (typeof window === "undefined") {
      return false;
    }

    // Check for AudioContext support
    const hasAudioContext = "AudioContext" in window || "webkitAudioContext" in window;

    // Check for storage API (used by piper-tts-web for OPFS)
    const hasStorageAPI = "storage" in navigator && "getDirectory" in navigator.storage;

    return hasAudioContext && hasStorageAPI;
  }

  /**
   * Gets available enhanced voices with their download status.
   *
   * @returns Promise resolving to array of available voices.
   */
  async getVoices(): Promise<TTSVoice[]> {
    if (!this.isAvailable()) {
      return [];
    }

    // Get list of downloaded voices from OPFS
    const downloadedVoiceIds = await this.getStoredVoiceIds();
    const downloadedSet = new Set(downloadedVoiceIds);

    return ENHANCED_VOICES.map((voice) => ({
      id: voice.id,
      name: voice.displayName,
      language: voice.language,
      provider: "piper" as const,
      downloadStatus: downloadedSet.has(voice.id)
        ? ("downloaded" as const)
        : ("not-downloaded" as const),
    }));
  }

  /**
   * Downloads a voice model for offline use.
   *
   * @param voiceId - The voice ID to download.
   * @param onProgress - Optional callback for download progress.
   * @throws Error if the voice ID is unknown.
   */
  async downloadVoice(voiceId: string, onProgress?: (progress: number) => void): Promise<void> {
    const voice = findEnhancedVoice(voiceId);
    if (!voice) {
      throw new Error(`Unknown voice: ${voiceId}`);
    }

    const piper = await getPiperTTS();

    await piper.download(voiceId, (progress) => {
      if (progress.total > 0) {
        onProgress?.(progress.loaded / progress.total);
      }
    });

    // Ensure progress shows 100% on completion
    onProgress?.(1);
  }

  /**
   * Removes a downloaded voice from storage.
   *
   * @param voiceId - The voice ID to remove.
   */
  async removeVoice(voiceId: string): Promise<void> {
    const piper = await getPiperTTS();
    await piper.remove(voiceId);
  }

  /**
   * Gets the list of voice IDs that are currently downloaded.
   *
   * @returns Promise resolving to array of downloaded voice IDs.
   */
  async getStoredVoiceIds(): Promise<string[]> {
    try {
      const piper = await getPiperTTS();
      return await piper.stored();
    } catch {
      // If OPFS is not available or fails, return empty array
      return [];
    }
  }

  /**
   * Speaks the given text using Piper TTS.
   *
   * @param text - The text to speak.
   * @param options - Speaking options.
   * @throws VoiceNotDownloadedError if the voice is not downloaded.
   */
  async speak(text: string, options: SpeakOptions): Promise<void> {
    if (!this.isAvailable()) {
      options.onError?.(new Error("Piper TTS is not available in this browser"));
      return;
    }

    // Stop any current speech
    this.stop();

    // Validate voice is provided
    const voiceId = options.voiceId;
    if (!voiceId) {
      options.onError?.(new Error("Voice ID is required for Piper TTS"));
      return;
    }

    // Check if voice is an enhanced voice
    const voice = findEnhancedVoice(voiceId);
    if (!voice) {
      options.onError?.(new Error(`Unknown enhanced voice: ${voiceId}`));
      return;
    }

    // Check if voice is downloaded
    const storedVoices = await this.getStoredVoiceIds();
    if (!storedVoices.includes(voiceId)) {
      options.onError?.(new VoiceNotDownloadedError(voiceId));
      return;
    }

    this.currentOptions = options;
    this.isPaused = false;

    try {
      // Generate audio using Piper with custom WASM paths
      const piper = await getPiperTTS();
      const session = await piper.TtsSession.create({
        voiceId,
        wasmPaths: CUSTOM_WASM_PATHS,
      });
      const wavBlob = await session.predict(text);

      // Check if we were stopped while generating
      if (this.currentOptions !== options) {
        return;
      }

      // Decode the audio
      const arrayBuffer = await wavBlob.arrayBuffer();
      const audioContext = this.getAudioContext();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // Store buffer for resume functionality
      this.currentBuffer = audioBuffer;

      // Apply playback rate
      const rate = clamp(options.rate ?? DEFAULT_RATE, MIN_RATE, MAX_RATE);

      // Create and configure the source
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.playbackRate.value = rate;
      source.connect(audioContext.destination);

      // Set up completion handler
      source.onended = () => {
        if (!this.isPaused && this.currentSource === source) {
          this.currentSource = null;
          this.currentBuffer = null;
          this.currentOptions = null;
          options.onEnd?.();
        }
      };

      this.currentSource = source;
      this.startedAt = audioContext.currentTime;
      this.pausedAt = 0;

      // Start playback
      source.start(0);
      options.onStart?.();
    } catch (error) {
      this.currentOptions = null;
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Stops any current speech immediately.
   */
  stop(): void {
    this.isPaused = false;
    this.pausedAt = 0;
    this.startedAt = 0;
    this.currentBuffer = null;
    this.currentOptions = null;

    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // Ignore errors if source was already stopped
      }
      this.currentSource = null;
    }
  }

  /**
   * Pauses current speech.
   *
   * Note: Piper TTS uses AudioBufferSourceNode which cannot truly pause.
   * We stop the source and remember the position to resume from.
   */
  pause(): void {
    if (!this.currentSource || !this.audioContext) {
      return;
    }

    this.isPaused = true;

    // Calculate how far we were into the audio
    const rate = this.currentSource.playbackRate.value;
    this.pausedAt = (this.audioContext.currentTime - this.startedAt) * rate;

    // Stop the current source
    try {
      this.currentSource.stop();
    } catch {
      // Ignore errors if source was already stopped
    }
    this.currentSource = null;
  }

  /**
   * Resumes paused speech.
   *
   * Since AudioBufferSourceNode cannot truly resume, we create a new
   * source and start it from where we paused.
   */
  resume(): void {
    if (!this.isPaused || !this.currentBuffer || !this.audioContext || !this.currentOptions) {
      return;
    }

    this.isPaused = false;

    const options = this.currentOptions;
    const rate = clamp(options.rate ?? DEFAULT_RATE, MIN_RATE, MAX_RATE);

    // Create a new source
    const source = this.audioContext.createBufferSource();
    source.buffer = this.currentBuffer;
    source.playbackRate.value = rate;
    source.connect(this.audioContext.destination);

    // Set up completion handler
    source.onended = () => {
      if (!this.isPaused && this.currentSource === source) {
        this.currentSource = null;
        this.currentBuffer = null;
        this.currentOptions = null;
        options.onEnd?.();
      }
    };

    this.currentSource = source;
    this.startedAt = this.audioContext.currentTime - this.pausedAt / rate;

    // Start from where we paused
    source.start(0, this.pausedAt);
  }

  /**
   * Checks if speech is currently paused.
   */
  isPausedState(): boolean {
    return this.isPaused;
  }

  /**
   * Gets or creates the AudioContext.
   */
  private getAudioContext(): AudioContext {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  /**
   * Closes the AudioContext and releases resources.
   * Call this when the provider is no longer needed.
   */
  async close(): Promise<void> {
    this.stop();

    if (this.audioContext) {
      await this.audioContext.close();
      this.audioContext = null;
    }
  }
}

/**
 * Singleton instance of the Piper TTS provider.
 */
let piperProviderInstance: PiperTTSProvider | null = null;

/**
 * Gets the singleton Piper TTS provider instance.
 *
 * @returns The Piper TTS provider instance.
 */
export function getPiperTTSProvider(): PiperTTSProvider {
  if (!piperProviderInstance) {
    piperProviderInstance = new PiperTTSProvider();
  }
  return piperProviderInstance;
}
