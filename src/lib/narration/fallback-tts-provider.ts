/**
 * Fallback TTS Provider
 *
 * Wraps any TTSProvider with automatic fallback to browser TTS on errors.
 * This ensures narration continues even if the primary provider fails.
 *
 * @module narration/fallback-tts-provider
 */

import type { TTSProvider, TTSVoice, SpeakOptions, TTSProviderId } from "./types";
import { getBrowserTTSProvider } from "./browser-tts-provider";

/**
 * Callback invoked when fallback to browser TTS occurs.
 */
export type FallbackCallback = (error: Error, fallbackProvider: TTSProvider) => void;

/**
 * Options for creating a FallbackTTSProvider.
 */
export interface FallbackTTSProviderOptions {
  /**
   * The primary TTS provider to use.
   */
  primary: TTSProvider;

  /**
   * Optional fallback provider. Defaults to BrowserTTSProvider.
   */
  fallback?: TTSProvider;

  /**
   * Optional callback when fallback occurs.
   * Use this to show notifications to the user.
   */
  onFallback?: FallbackCallback;
}

/**
 * FallbackTTSProvider wraps a primary provider with automatic fallback behavior.
 *
 * If the primary provider fails during speak(), it automatically falls back
 * to a browser TTS provider (or a custom fallback provider) and notifies
 * via the onFallback callback.
 *
 * Use cases:
 * - Wrap PiperTTSProvider to fall back to browser TTS if WASM fails
 * - Ensure narration always works even with provider failures
 *
 * @example
 * ```ts
 * const piperProvider = new PiperTTSProvider();
 * const fallbackProvider = new FallbackTTSProvider({
 *   primary: piperProvider,
 *   onFallback: (error, fallback) => {
 *     showToast("Enhanced voice unavailable. Using browser voice.");
 *     console.error("Piper failed:", error);
 *   },
 * });
 *
 * await fallbackProvider.speak("Hello world", options);
 * ```
 */
export class FallbackTTSProvider implements TTSProvider {
  private readonly primary: TTSProvider;
  private readonly fallback: TTSProvider;
  private readonly onFallback?: FallbackCallback;
  private usingFallback = false;

  /**
   * Creates a new FallbackTTSProvider.
   *
   * @param options - Configuration options.
   */
  constructor(options: FallbackTTSProviderOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback ?? getBrowserTTSProvider();
    this.onFallback = options.onFallback;
  }

  /**
   * Returns the ID of the currently active provider.
   */
  get id(): TTSProviderId {
    return this.usingFallback ? this.fallback.id : this.primary.id;
  }

  /**
   * Returns the name of the currently active provider.
   */
  get name(): string {
    return this.usingFallback ? this.fallback.name : this.primary.name;
  }

  /**
   * Checks if at least one provider is available.
   * Returns true if either primary or fallback is available.
   */
  isAvailable(): boolean {
    return this.primary.isAvailable() || this.fallback.isAvailable();
  }

  /**
   * Returns whether the fallback provider is currently active.
   */
  isUsingFallback(): boolean {
    return this.usingFallback;
  }

  /**
   * Resets to using the primary provider.
   * Call this to try the primary provider again after a fallback.
   */
  resetToFrimary(): void {
    this.usingFallback = false;
  }

  /**
   * Gets voices from the currently active provider.
   */
  async getVoices(): Promise<TTSVoice[]> {
    const activeProvider = this.usingFallback ? this.fallback : this.primary;
    return activeProvider.getVoices();
  }

  /**
   * Speaks text with automatic fallback on error.
   *
   * If the primary provider fails, automatically falls back to the
   * browser provider and retries the speak operation.
   *
   * @param text - The text to speak.
   * @param options - Speaking options.
   */
  async speak(text: string, options: SpeakOptions): Promise<void> {
    // If already using fallback, use it directly
    if (this.usingFallback) {
      return this.speakWithFallback(text, options);
    }

    // Check if primary is available
    if (!this.primary.isAvailable()) {
      console.warn("FallbackTTSProvider: Primary provider not available, using fallback");
      return this.activateFallbackAndSpeak(
        text,
        options,
        new Error("Primary provider not available")
      );
    }

    // Try primary provider with error handling
    return new Promise<void>((resolve, reject) => {
      let hasErrored = false;

      const wrappedOptions: SpeakOptions = {
        ...options,
        onError: async (error) => {
          if (hasErrored) return; // Prevent double handling
          hasErrored = true;

          console.error("FallbackTTSProvider: Primary provider error:", error);

          // Try fallback
          try {
            await this.activateFallbackAndSpeak(text, options, error);
            resolve();
          } catch (fallbackError) {
            // Both providers failed
            options.onError?.(
              fallbackError instanceof Error ? fallbackError : new Error(String(fallbackError))
            );
            reject(fallbackError);
          }
        },
        onEnd: () => {
          options.onEnd?.();
          resolve();
        },
      };

      // Start speaking with primary
      this.primary.speak(text, wrappedOptions).catch((error) => {
        if (hasErrored) return;
        hasErrored = true;

        console.error("FallbackTTSProvider: Primary speak() threw:", error);

        this.activateFallbackAndSpeak(
          text,
          options,
          error instanceof Error ? error : new Error(String(error))
        )
          .then(resolve)
          .catch(reject);
      });
    });
  }

  /**
   * Activates fallback and speaks the text.
   */
  private async activateFallbackAndSpeak(
    text: string,
    options: SpeakOptions,
    originalError: Error
  ): Promise<void> {
    if (!this.fallback.isAvailable()) {
      throw new Error("Both primary and fallback providers are unavailable");
    }

    this.usingFallback = true;

    // Notify about fallback
    this.onFallback?.(originalError, this.fallback);

    // Speak with fallback, but don't pass the voice ID since it's provider-specific
    return this.speakWithFallback(text, options);
  }

  /**
   * Speaks using the fallback provider with appropriate options.
   */
  private async speakWithFallback(text: string, options: SpeakOptions): Promise<void> {
    // Don't pass provider-specific voiceId to fallback
    // The fallback provider will use its default voice
    const fallbackOptions: SpeakOptions = {
      ...options,
      voiceId: undefined, // Let fallback use default voice
    };

    return this.fallback.speak(text, fallbackOptions);
  }

  /**
   * Stops any current speech.
   */
  stop(): void {
    this.primary.stop();
    this.fallback.stop();
  }

  /**
   * Pauses current speech.
   */
  pause(): void {
    if (this.usingFallback) {
      this.fallback.pause();
    } else {
      this.primary.pause();
    }
  }

  /**
   * Resumes paused speech.
   */
  resume(): void {
    if (this.usingFallback) {
      this.fallback.resume();
    } else {
      this.primary.resume();
    }
  }
}

/**
 * Creates a FallbackTTSProvider with the given options.
 *
 * This is a convenience function for creating a FallbackTTSProvider.
 *
 * @param options - Configuration options.
 * @returns A new FallbackTTSProvider instance.
 */
export function createFallbackProvider(options: FallbackTTSProviderOptions): FallbackTTSProvider {
  return new FallbackTTSProvider(options);
}
