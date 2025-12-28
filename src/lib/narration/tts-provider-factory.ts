/**
 * TTS Provider Factory
 *
 * Creates TTS provider instances based on user settings.
 * Handles automatic fallback to browser TTS when enhanced voices fail.
 *
 * @module narration/tts-provider-factory
 */

import type { TTSProvider } from "./types";
import type { NarrationSettings } from "./settings";
import { getBrowserTTSProvider } from "./browser-tts-provider";
import { getPiperTTSProvider } from "./piper-tts-provider";
import { FallbackTTSProvider, type FallbackCallback } from "./fallback-tts-provider";

/**
 * Options for creating a TTS provider.
 */
export interface CreateTTSProviderOptions {
  /**
   * User's narration settings including provider preference.
   */
  settings: Pick<NarrationSettings, "provider">;

  /**
   * Optional callback when fallback to browser TTS occurs.
   * Use this to show toast notifications to the user.
   */
  onFallback?: FallbackCallback;

  /**
   * Whether to wrap the provider with fallback behavior.
   * Default: true for piper provider, false for browser provider.
   */
  enableFallback?: boolean;
}

/**
 * Result of creating a TTS provider.
 */
export interface CreateTTSProviderResult {
  /**
   * The created TTS provider.
   */
  provider: TTSProvider;

  /**
   * Whether the provider was wrapped with fallback behavior.
   */
  hasFallback: boolean;

  /**
   * Whether the primary provider is available.
   * If false and hasFallback is true, the fallback will be used immediately.
   */
  primaryAvailable: boolean;
}

/**
 * Creates a TTS provider based on user settings.
 *
 * For the "piper" provider, this wraps the provider with automatic
 * fallback to browser TTS if Piper fails to load or speak.
 *
 * @param options - Configuration options.
 * @returns The created TTS provider with metadata.
 *
 * @example
 * ```ts
 * const { provider, hasFallback } = createTTSProvider({
 *   settings: { provider: "piper" },
 *   onFallback: (error) => {
 *     showToast("Enhanced voice unavailable. Using browser voice.");
 *     console.error("Piper failed:", error);
 *   },
 * });
 *
 * await provider.speak("Hello world", options);
 * ```
 */
export function createTTSProvider(options: CreateTTSProviderOptions): CreateTTSProviderResult {
  const { settings, onFallback, enableFallback } = options;

  // Browser provider - no fallback needed
  if (settings.provider === "browser") {
    const browserProvider = getBrowserTTSProvider();
    return {
      provider: browserProvider,
      hasFallback: false,
      primaryAvailable: browserProvider.isAvailable(),
    };
  }

  // Piper provider - wrap with fallback by default
  const piperProvider = getPiperTTSProvider();
  const shouldEnableFallback = enableFallback ?? true;

  if (!shouldEnableFallback) {
    return {
      provider: piperProvider,
      hasFallback: false,
      primaryAvailable: piperProvider.isAvailable(),
    };
  }

  // Create fallback wrapper
  const fallbackProvider = new FallbackTTSProvider({
    primary: piperProvider,
    fallback: getBrowserTTSProvider(),
    onFallback: (error, fallback) => {
      // Log the error for debugging
      console.warn("TTS fallback activated:", {
        error: error.message,
        fallbackProvider: fallback.name,
      });

      // Call user's callback if provided
      onFallback?.(error, fallback);
    },
  });

  return {
    provider: fallbackProvider,
    hasFallback: true,
    primaryAvailable: piperProvider.isAvailable(),
  };
}

/**
 * Gets a TTS provider based on settings with fallback behavior.
 *
 * This is a simpler version of createTTSProvider that just returns
 * the provider without metadata.
 *
 * @param settings - User's narration settings.
 * @param onFallback - Optional callback when fallback occurs.
 * @returns The TTS provider.
 *
 * @example
 * ```ts
 * const provider = getTTSProvider(settings, (error) => {
 *   showToast("Enhanced voice unavailable. Using browser voice.");
 * });
 * ```
 */
export function getTTSProvider(
  settings: Pick<NarrationSettings, "provider">,
  onFallback?: FallbackCallback
): TTSProvider {
  return createTTSProvider({ settings, onFallback }).provider;
}

/**
 * Checks if the Piper provider is available in the current environment.
 *
 * Use this to determine whether to show enhanced voice options in the UI.
 *
 * @returns true if Piper TTS can be used, false otherwise.
 */
export function isPiperAvailable(): boolean {
  const piperProvider = getPiperTTSProvider();
  return piperProvider.isAvailable();
}

/**
 * Gets the best available TTS provider.
 *
 * Returns Piper if available, otherwise Browser TTS.
 * Useful for determining default provider in settings.
 *
 * @returns The best available provider ID.
 */
export function getBestAvailableProvider(): "piper" | "browser" {
  if (isPiperAvailable()) {
    return "piper";
  }
  return "browser";
}
