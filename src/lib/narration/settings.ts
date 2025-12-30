/**
 * Narration settings management.
 *
 * Provides utilities for loading, saving, and managing narration preferences
 * including voice selection, playback rate, and pitch.
 */

"use client";

import { useState, useCallback } from "react";
import type { TTSProviderId } from "./types";

/**
 * User preferences for narration playback.
 */
export interface NarrationSettings {
  /**
   * Whether narration is enabled.
   */
  enabled: boolean;

  /**
   * Which TTS provider to use.
   * - "browser": Native Web Speech API voices (default)
   * - "piper": Enhanced voices via Piper TTS (requires download)
   */
  provider: TTSProviderId;

  /**
   * The voice ID to use for narration.
   *
   * For browser provider: this is the voiceURI (SpeechSynthesisVoice.voiceURI).
   * For Piper provider: this is the model ID (e.g., "en_US-lessac-medium").
   *
   * Null means use the provider's default voice.
   */
  voiceId: string | null;

  /**
   * @deprecated Use voiceId instead. Kept for backwards compatibility.
   * Will be migrated to voiceId on load.
   */
  voiceUri?: string | null;

  /**
   * Playback rate multiplier (0.5 - 2.0, default 1.0).
   */
  rate: number;

  /**
   * Voice pitch multiplier (0.5 - 2.0, default 1.0).
   */
  pitch: number;

  /**
   * Whether to highlight the current paragraph during narration.
   * Default: true.
   */
  highlightEnabled: boolean;

  /**
   * Whether to automatically scroll to the highlighted paragraph during narration.
   * Only scrolls if the paragraph is not already visible in the viewport.
   * Default: true
   */
  autoScrollEnabled: boolean;

  /**
   * Whether to use LLM preprocessing for narration.
   * When enabled, content is processed by an LLM to improve TTS quality
   * (expanding abbreviations, formatting URLs, etc.).
   * When disabled, uses simple HTML-to-text conversion.
   * Default: false
   */
  useLlmNormalization: boolean;

  /**
   * Silence gap between sentences in seconds when using Piper TTS.
   * This affects how long the pause is between sentences within a paragraph.
   * Range: 0.0 - 1.0 seconds
   * Default: 0.3 seconds
   */
  sentenceGapSeconds: number;
}

/**
 * Default narration settings.
 */
export const DEFAULT_NARRATION_SETTINGS: NarrationSettings = {
  enabled: true,
  provider: "browser",
  voiceId: null,
  rate: 1.0,
  pitch: 1.0,
  highlightEnabled: true,
  autoScrollEnabled: true,
  useLlmNormalization: false,
  sentenceGapSeconds: 0.1,
};

/**
 * localStorage key for narration settings.
 */
const STORAGE_KEY = "lion-reader-narration-settings";

/**
 * Loads narration settings from localStorage.
 *
 * Returns the saved settings merged with defaults (in case new fields
 * are added in future versions). Returns defaults if no saved settings
 * exist or if localStorage is unavailable.
 *
 * @returns The loaded narration settings.
 *
 * @example
 * ```ts
 * const settings = loadNarrationSettings();
 * console.log(`Rate: ${settings.rate}x`);
 * ```
 */
export function loadNarrationSettings(): NarrationSettings {
  if (typeof window === "undefined") {
    return DEFAULT_NARRATION_SETTINGS;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_NARRATION_SETTINGS;
    }

    const parsed = JSON.parse(stored) as Partial<NarrationSettings> & { voiceUri?: string | null };

    // Handle migration from voiceUri to voiceId
    // If voiceId is not present but voiceUri is, use voiceUri as voiceId
    let voiceId: string | null = null;
    if (typeof parsed.voiceId === "string") {
      voiceId = parsed.voiceId;
    } else if (typeof parsed.voiceUri === "string") {
      // Migration: use old voiceUri as voiceId
      voiceId = parsed.voiceUri;
    }

    // Validate provider value
    const validProviders = ["browser", "piper"] as const;
    const provider =
      typeof parsed.provider === "string" &&
      validProviders.includes(parsed.provider as "browser" | "piper")
        ? (parsed.provider as "browser" | "piper")
        : DEFAULT_NARRATION_SETTINGS.provider;

    // Merge with defaults to handle new fields in future versions
    return {
      enabled:
        typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NARRATION_SETTINGS.enabled,
      provider,
      voiceId,
      rate:
        typeof parsed.rate === "number" && parsed.rate >= 0.5 && parsed.rate <= 2.0
          ? parsed.rate
          : DEFAULT_NARRATION_SETTINGS.rate,
      pitch:
        typeof parsed.pitch === "number" && parsed.pitch >= 0.5 && parsed.pitch <= 2.0
          ? parsed.pitch
          : DEFAULT_NARRATION_SETTINGS.pitch,
      highlightEnabled:
        typeof parsed.highlightEnabled === "boolean"
          ? parsed.highlightEnabled
          : DEFAULT_NARRATION_SETTINGS.highlightEnabled,
      autoScrollEnabled:
        typeof parsed.autoScrollEnabled === "boolean"
          ? parsed.autoScrollEnabled
          : DEFAULT_NARRATION_SETTINGS.autoScrollEnabled,
      useLlmNormalization:
        typeof parsed.useLlmNormalization === "boolean"
          ? parsed.useLlmNormalization
          : DEFAULT_NARRATION_SETTINGS.useLlmNormalization,
      sentenceGapSeconds:
        typeof parsed.sentenceGapSeconds === "number" &&
        parsed.sentenceGapSeconds >= 0 &&
        parsed.sentenceGapSeconds <= 1.0
          ? parsed.sentenceGapSeconds
          : DEFAULT_NARRATION_SETTINGS.sentenceGapSeconds,
    };
  } catch {
    // If parsing fails, return defaults
    return DEFAULT_NARRATION_SETTINGS;
  }
}

/**
 * Saves narration settings to localStorage.
 *
 * @param settings - The settings to save.
 *
 * @example
 * ```ts
 * saveNarrationSettings({
 *   enabled: true,
 *   voiceUri: "com.apple.voice.compact.en-US.Samantha",
 *   rate: 1.25,
 *   pitch: 1.0,
 * });
 * ```
 */
export function saveNarrationSettings(settings: NarrationSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Silently fail if localStorage is full or unavailable
  }
}

/**
 * React hook for managing narration settings.
 *
 * Uses lazy initialization to load settings from localStorage on first render.
 * The returned setter function automatically saves changes to localStorage.
 *
 * @returns A tuple of [settings, setSettings].
 *
 * @example
 * ```tsx
 * function NarrationControls() {
 *   const [settings, setSettings] = useNarrationSettings();
 *
 *   return (
 *     <select
 *       value={settings.voiceUri || ''}
 *       onChange={(e) => setSettings({ ...settings, voiceUri: e.target.value })}
 *     >
 *       {voices.map(voice => (
 *         <option key={voice.voiceURI} value={voice.voiceURI}>
 *           {voice.name}
 *         </option>
 *       ))}
 *     </select>
 *   );
 * }
 * ```
 */
export function useNarrationSettings(): [NarrationSettings, (settings: NarrationSettings) => void] {
  // Use lazy initialization to load settings from localStorage.
  // This runs only once on first render and avoids cascading renders from useEffect.
  // Note: This may cause a hydration mismatch if server/client localStorage differs,
  // but for user preferences this is acceptable behavior.
  const [settings, setSettingsState] = useState<NarrationSettings>(() => loadNarrationSettings());

  // Save and update settings
  const setSettings = useCallback((newSettings: NarrationSettings) => {
    setSettingsState(newSettings);
    saveNarrationSettings(newSettings);
  }, []);

  return [settings, setSettings];
}
