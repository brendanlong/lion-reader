/**
 * Piper TTS Provider
 *
 * Piper TTS via WebAssembly: high-quality neural text-to-speech that runs
 * entirely in the browser.
 *
 * @module narration/piper-tts-provider
 */

import { findEnhancedVoice } from "./enhanced-voices";

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
 * PiperTTSProvider wraps Piper TTS via WebAssembly: voice model storage and
 * synthesis. Playback goes through `MediaSourcePlayer` like every other
 * synthesized voice.
 *
 * Voice models are a ~17-50 MB download each, kept in the Origin Private File
 * System.
 */
export class PiperTTSProvider {
  /**
   * Checks if Piper TTS is available in the current environment: it needs the
   * Origin Private File System (via navigator.storage) for model storage.
   */
  isAvailable(): boolean {
    return (
      typeof window !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage
    );
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
   * Synthesizes text as a WAV clip.
   *
   * @throws VoiceNotDownloadedError if the voice is not downloaded.
   */
  async synthesize(text: string, voiceId: string): Promise<Blob> {
    if (!this.isAvailable()) {
      throw new Error("Piper TTS is not available in this browser");
    }

    const voice = findEnhancedVoice(voiceId);
    if (!voice) {
      throw new Error(`Unknown enhanced voice: ${voiceId}`);
    }

    const storedVoices = await this.getStoredVoiceIds();
    if (!storedVoices.includes(voiceId)) {
      throw new VoiceNotDownloadedError(voiceId);
    }

    const piper = await getPiperTTS();
    await ensureCorrectVoiceLoaded(piper, voiceId);
    const session = await piper.TtsSession.create({
      voiceId,
      wasmPaths: CUSTOM_WASM_PATHS,
    });
    return session.predict(text);
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
