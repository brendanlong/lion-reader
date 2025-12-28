/**
 * Browser TTS Provider
 *
 * Implements the TTSProvider interface using the Web Speech API.
 * This is the default provider that works in all modern browsers.
 *
 * @module narration/browser-tts-provider
 */

import type { TTSProvider, TTSVoice, SpeakOptions } from "./types";
import { isFirefox } from "./feature-detection";
import { waitForVoices as waitForBrowserVoices } from "./voices";

/**
 * Default speech rate (1.0 = normal speed).
 */
const DEFAULT_RATE = 1.0;

/**
 * Default speech pitch (1.0 = normal pitch).
 */
const DEFAULT_PITCH = 1.0;

/**
 * Minimum allowed rate value.
 */
const MIN_RATE = 0.5;

/**
 * Maximum allowed rate value.
 */
const MAX_RATE = 2.0;

/**
 * Minimum allowed pitch value.
 */
const MIN_PITCH = 0.5;

/**
 * Maximum allowed pitch value.
 */
const MAX_PITCH = 2.0;

/**
 * Clamps a value between a minimum and maximum.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * BrowserTTSProvider implements TTSProvider using the Web Speech API.
 *
 * This provider wraps the browser's native text-to-speech capabilities,
 * providing access to the system's installed voices.
 *
 * Features:
 * - Uses native browser voices (no downloads required)
 * - Works offline with local voices
 * - Supports pause/resume (with Firefox workaround)
 * - Immediate playback with no preprocessing
 *
 * Limitations:
 * - Voice quality varies by browser and OS
 * - Firefox has broken pause/resume (we cancel and restart instead)
 */
export class BrowserTTSProvider implements TTSProvider {
  readonly id = "browser" as const;
  readonly name = "Browser Voices";

  private currentUtterance: SpeechSynthesisUtterance | null = null;
  private currentOptions: SpeakOptions | null = null;
  private currentText: string | null = null;
  private isPaused = false;
  private readonly isFirefoxBrowser: boolean;

  constructor() {
    this.isFirefoxBrowser = isFirefox();
  }

  /**
   * Checks if the Web Speech API is available.
   */
  isAvailable(): boolean {
    return (
      typeof window !== "undefined" &&
      "speechSynthesis" in window &&
      "SpeechSynthesisUtterance" in window
    );
  }

  /**
   * Gets available browser voices as TTSVoice objects.
   *
   * @param languagePrefix - Optional language prefix to filter by (default: 'en')
   * @returns Promise resolving to array of available voices.
   */
  async getVoices(languagePrefix = "en"): Promise<TTSVoice[]> {
    if (!this.isAvailable()) {
      return [];
    }

    const browserVoices = await waitForBrowserVoices(languagePrefix);

    return browserVoices.map((voice) => ({
      id: voice.voiceURI,
      name: voice.name,
      language: voice.lang,
      provider: "browser" as const,
      // Browser voices are always "downloaded" (no download needed)
      downloadStatus: "downloaded" as const,
    }));
  }

  /**
   * Speaks the given text using the Web Speech API.
   *
   * @param text - The text to speak.
   * @param options - Speaking options.
   */
  async speak(text: string, options: SpeakOptions): Promise<void> {
    if (!this.isAvailable()) {
      options.onError?.(new Error("Web Speech API is not available"));
      return;
    }

    // Cancel any existing speech
    this.stop();

    // Store for resume functionality
    this.currentText = text;
    this.currentOptions = options;
    this.isPaused = false;

    // Create utterance
    const utterance = new SpeechSynthesisUtterance(text);
    this.currentUtterance = utterance;

    // Apply voice if specified
    if (options.voiceId) {
      const voices = speechSynthesis.getVoices();
      const voice = voices.find((v) => v.voiceURI === options.voiceId);
      if (voice) {
        utterance.voice = voice;
      }
    }

    // Apply rate and pitch
    utterance.rate = clamp(options.rate ?? DEFAULT_RATE, MIN_RATE, MAX_RATE);
    utterance.pitch = clamp(options.pitch ?? DEFAULT_PITCH, MIN_PITCH, MAX_PITCH);

    // Set up event handlers
    utterance.onstart = () => {
      options.onStart?.();
    };

    utterance.onend = () => {
      // Only call onEnd if we weren't stopped/paused
      if (!this.isPaused && this.currentUtterance === utterance) {
        this.currentUtterance = null;
        this.currentText = null;
        this.currentOptions = null;
        options.onEnd?.();
      }
    };

    utterance.onerror = (event) => {
      // 'interrupted' and 'canceled' are not real errors - they happen when
      // we intentionally stop or skip
      if (event.error === "interrupted" || event.error === "canceled") {
        return;
      }

      this.currentUtterance = null;
      this.currentText = null;
      this.currentOptions = null;
      options.onError?.(new Error(`Speech synthesis error: ${event.error}`));
    };

    // Start speaking
    speechSynthesis.speak(utterance);
  }

  /**
   * Stops any current speech immediately.
   */
  stop(): void {
    if (!this.isAvailable()) {
      return;
    }

    this.isPaused = false;
    this.currentUtterance = null;
    this.currentText = null;
    this.currentOptions = null;
    speechSynthesis.cancel();
  }

  /**
   * Pauses current speech.
   *
   * Note: Firefox has a known bug where pause() doesn't work.
   * On Firefox, we use cancel() and remember the position for resume.
   */
  pause(): void {
    if (!this.isAvailable() || !this.currentUtterance) {
      return;
    }

    this.isPaused = true;

    if (this.isFirefoxBrowser) {
      // Firefox workaround: cancel instead of pause
      // We'll restart from the beginning on resume
      speechSynthesis.cancel();
    } else {
      speechSynthesis.pause();
    }
  }

  /**
   * Resumes paused speech.
   *
   * Note: On Firefox, since we used cancel() instead of pause(),
   * we restart the speech from the beginning.
   */
  resume(): void {
    if (!this.isAvailable() || !this.isPaused) {
      return;
    }

    this.isPaused = false;

    if (this.isFirefoxBrowser) {
      // Firefox workaround: restart from beginning
      if (this.currentText && this.currentOptions) {
        // Re-speak the current text
        void this.speak(this.currentText, this.currentOptions);
      }
    } else {
      speechSynthesis.resume();
    }
  }

  /**
   * Checks if speech is currently paused.
   */
  isPausedState(): boolean {
    return this.isPaused;
  }

  /**
   * Gets the native SpeechSynthesisVoice by voice ID.
   *
   * Useful for components that need to work with both the provider
   * interface and the raw Web Speech API.
   *
   * @param voiceId - The voice ID (voiceURI) to find.
   * @returns The native voice object, or null if not found.
   */
  getNativeVoice(voiceId: string): SpeechSynthesisVoice | null {
    if (!this.isAvailable()) {
      return null;
    }

    const voices = speechSynthesis.getVoices();
    return voices.find((v) => v.voiceURI === voiceId) ?? null;
  }
}

/**
 * Singleton instance of the browser TTS provider.
 *
 * Use this for cases where you need a quick reference to the browser provider
 * without creating a new instance.
 */
let browserProviderInstance: BrowserTTSProvider | null = null;

/**
 * Gets the singleton browser TTS provider instance.
 *
 * @returns The browser TTS provider instance.
 */
export function getBrowserTTSProvider(): BrowserTTSProvider {
  if (!browserProviderInstance) {
    browserProviderInstance = new BrowserTTSProvider();
  }
  return browserProviderInstance;
}
