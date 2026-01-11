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
import { splitIntoSentences } from "./sentence-splitter";
import { concatenateAudioBuffers, DEFAULT_SENTENCE_GAP_SECONDS } from "./audio-buffer-utils";
import { DEFAULT_RATE, MIN_RATE, MAX_RATE, clamp } from "./constants";

/**
 * Dynamically imports the piper-tts-web module.
 * This allows for code splitting and lazy loading.
 */
async function getPiperTTS(): Promise<typeof import("@mintplex-labs/piper-tts-web")> {
  return import("@mintplex-labs/piper-tts-web");
}

/**
 * Tracks the voice ID currently loaded in the TtsSession singleton.
 * The piper-tts-web library uses a singleton pattern that doesn't reload
 * the voice model when switching voices - it only updates the voiceId string.
 * We need to manually reset the singleton when switching to a different voice.
 */
let currentlyLoadedVoiceId: string | null = null;

/**
 * Resets the TtsSession singleton if a different voice is requested.
 * This works around a limitation in the piper-tts-web library where
 * the singleton caches the first voice model and reuses it even when
 * a different voiceId is requested.
 */
async function ensureCorrectVoiceLoaded(
  piper: typeof import("@mintplex-labs/piper-tts-web"),
  voiceId: string
): Promise<void> {
  if (currentlyLoadedVoiceId !== null && currentlyLoadedVoiceId !== voiceId) {
    // Reset the singleton to force loading the new voice model
    // The TtsSession class uses a static _instance property for the singleton
    const TtsSession = piper.TtsSession as typeof piper.TtsSession & {
      _instance: unknown | null;
    };
    TtsSession._instance = null;
  }
  currentlyLoadedVoiceId = voiceId;
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
   * Generates audio for text without playing it.
   * Useful for pre-buffering upcoming paragraphs.
   *
   * @param text - The text to synthesize.
   * @param voiceId - The voice ID to use.
   * @returns Promise resolving to the AudioBuffer.
   * @throws Error if voice is not available or synthesis fails.
   */
  async generateAudio(text: string, voiceId: string): Promise<AudioBuffer> {
    if (!this.isAvailable()) {
      throw new Error("Piper TTS is not available in this browser");
    }

    // Check if voice is an enhanced voice
    const voice = findEnhancedVoice(voiceId);
    if (!voice) {
      throw new Error(`Unknown enhanced voice: ${voiceId}`);
    }

    // Check if voice is downloaded
    const storedVoices = await this.getStoredVoiceIds();
    if (!storedVoices.includes(voiceId)) {
      throw new VoiceNotDownloadedError(voiceId);
    }

    // Generate audio using Piper with custom WASM paths
    const piper = await getPiperTTS();

    // Ensure the correct voice model is loaded (reset singleton if switching voices)
    await ensureCorrectVoiceLoaded(piper, voiceId);

    const session = await piper.TtsSession.create({
      voiceId,
      wasmPaths: CUSTOM_WASM_PATHS,
    });
    const wavBlob = await session.predict(text);

    // Decode the audio
    const arrayBuffer = await wavBlob.arrayBuffer();
    const audioContext = this.getAudioContext();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    return audioBuffer;
  }

  /**
   * Generates audio for a paragraph by splitting it into sentences,
   * synthesizing each sentence separately, and concatenating the results
   * with silence gaps between sentences.
   *
   * This approach improves TTS quality by giving the neural model
   * smaller chunks to process, resulting in better prosody.
   *
   * @param text - The paragraph text to synthesize.
   * @param voiceId - The voice ID to use.
   * @param gapSeconds - Silence gap between sentences (default: 0.3s).
   * @returns Promise resolving to the concatenated AudioBuffer.
   * @throws Error if voice is not available or synthesis fails.
   */
  async generateParagraphAudio(
    text: string,
    voiceId: string,
    gapSeconds: number = DEFAULT_SENTENCE_GAP_SECONDS
  ): Promise<AudioBuffer> {
    if (!this.isAvailable()) {
      throw new Error("Piper TTS is not available in this browser");
    }

    // Split paragraph into sentences
    const sentences = splitIntoSentences(text);

    if (sentences.length === 0) {
      // Empty text - return a minimal silent buffer
      const audioContext = this.getAudioContext();
      return audioContext.createBuffer(1, 1, audioContext.sampleRate);
    }

    // If only one sentence, use the simpler path
    if (sentences.length === 1) {
      return this.generateAudio(sentences[0], voiceId);
    }

    // Generate audio for each sentence
    const sentenceBuffers: AudioBuffer[] = [];

    for (const sentence of sentences) {
      const buffer = await this.generateAudio(sentence, voiceId);
      sentenceBuffers.push(buffer);
    }

    // Concatenate with silence gaps
    const audioContext = this.getAudioContext();
    const result = concatenateAudioBuffers(audioContext, sentenceBuffers, gapSeconds);

    return result.buffer;
  }

  /**
   * Plays a pre-generated AudioBuffer.
   * Useful for playing cached audio without regenerating.
   *
   * @param buffer - The AudioBuffer to play.
   * @param options - Speaking options.
   */
  playBuffer(buffer: AudioBuffer, options: SpeakOptions): void {
    // Stop any current speech
    this.stop();

    this.currentOptions = options;
    this.isPaused = false;
    this.currentBuffer = buffer;

    const audioContext = this.getAudioContext();

    // Apply playback rate
    const rate = clamp(options.rate ?? DEFAULT_RATE, MIN_RATE, MAX_RATE);

    // Create and configure the source
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
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

    // Validate voice is provided
    const voiceId = options.voiceId;
    if (!voiceId) {
      options.onError?.(new Error("Voice ID is required for Piper TTS"));
      return;
    }

    try {
      const audioBuffer = await this.generateAudio(text, voiceId);
      this.playBuffer(audioBuffer, options);
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
   * Public to allow external components to manipulate audio buffers.
   */
  getAudioContext(): AudioContext {
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
