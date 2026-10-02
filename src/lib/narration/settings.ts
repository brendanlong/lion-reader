/**
 * Narration settings management.
 *
 * Provides utilities for loading, saving, and managing narration preferences
 * including voice selection, playback rate, and pitch.
 */

"use client";

import { useSyncExternalStore } from "react";
import { TTS_PROVIDER_IDS, type TTSProviderId } from "./types";
import {
  DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS,
  DEFAULT_PITCH,
  DEFAULT_RATE,
  MAX_CLOUD_SPEECH_PAUSE_SECONDS,
  MAX_PITCH,
  MAX_RATE,
  MIN_PITCH,
  MIN_RATE,
} from "./constants";

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
   * - "cloud": Cloud voices (server-side speech models)
   */
  provider: TTSProviderId;

  /**
   * Speech model for cloud voices, as a `provider:model` ref. Null means the
   * default model.
   */
  cloudModelId: string | null;

  /**
   * The voice ID to use for narration.
   *
   * For browser provider: this is the voiceURI (SpeechSynthesisVoice.voiceURI).
   * For Piper provider: this is the model ID (e.g., "en_US-lessac-medium").
   * For cloud voices: a voice name the speech model lists (e.g., "af_heart").
   *
   * Null means use the provider's default voice.
   */
  voiceId: string | null;

  /** Playback rate multiplier, {@link MIN_RATE} to {@link MAX_RATE}. */
  rate: number;

  /** Voice pitch multiplier, {@link MIN_PITCH} to {@link MAX_PITCH}. */
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

  /** Silence between sentences with Piper voices, in seconds (0 to 1). */
  sentenceGapSeconds: number;

  /** Silence after each chunk of cloud speech, in seconds. */
  cloudPauseSeconds: number;
}

/**
 * Default narration settings.
 */
export const DEFAULT_NARRATION_SETTINGS: NarrationSettings = {
  enabled: true,
  provider: "browser",
  cloudModelId: null,
  voiceId: null,
  rate: DEFAULT_RATE,
  pitch: DEFAULT_PITCH,
  highlightEnabled: true,
  autoScrollEnabled: true,
  useLlmNormalization: false,
  sentenceGapSeconds: 0.1,
  cloudPauseSeconds: DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS,
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

    const parsed = JSON.parse(stored) as Partial<NarrationSettings>;

    const voiceId = typeof parsed.voiceId === "string" ? parsed.voiceId : null;

    // Validate provider value
    const provider =
      typeof parsed.provider === "string" &&
      (TTS_PROVIDER_IDS as readonly string[]).includes(parsed.provider)
        ? (parsed.provider as TTSProviderId)
        : DEFAULT_NARRATION_SETTINGS.provider;

    // Merge with defaults to handle new fields in future versions
    return {
      enabled:
        typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_NARRATION_SETTINGS.enabled,
      provider,
      cloudModelId: typeof parsed.cloudModelId === "string" ? parsed.cloudModelId : null,
      voiceId,
      rate:
        typeof parsed.rate === "number" && parsed.rate >= MIN_RATE && parsed.rate <= MAX_RATE
          ? parsed.rate
          : DEFAULT_NARRATION_SETTINGS.rate,
      pitch:
        typeof parsed.pitch === "number" && parsed.pitch >= MIN_PITCH && parsed.pitch <= MAX_PITCH
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
      cloudPauseSeconds:
        typeof parsed.cloudPauseSeconds === "number" &&
        parsed.cloudPauseSeconds >= 0 &&
        parsed.cloudPauseSeconds <= MAX_CLOUD_SPEECH_PAUSE_SECONDS
          ? parsed.cloudPauseSeconds
          : DEFAULT_NARRATION_SETTINGS.cloudPauseSeconds,
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
 * saveNarrationSettings({ ...loadNarrationSettings(), rate: 1.25 });
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
 * Type for the setSettings function - supports both direct value and functional updates.
 */
export type SetNarrationSettings = (
  settingsOrUpdater: NarrationSettings | ((prev: NarrationSettings) => NarrationSettings)
) => void;

// ============================================================================
// Shared store
// ============================================================================

// One module-level store so every `useNarrationSettings` caller sees the same
// value: a change made in the settings page reaches an open narration player
// (e.g. disabling narration stops it) without a reload.

const subscribers = new Set<() => void>();

/** The raw stored string the cached snapshot was parsed from. */
let cachedRaw: string | null = null;
/** Parsed snapshot; the same reference until the stored string changes. */
let cachedSettings: NarrationSettings | null = null;

function readRaw(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function getSnapshot(): NarrationSettings {
  // Keyed on the stored string rather than cached forever, so a write that
  // bypasses the setter (another tab — see subscribe) yields a new snapshot,
  // while an unchanged string keeps the same reference.
  const raw = readRaw();
  if (cachedSettings === null || raw !== cachedRaw) {
    cachedRaw = raw;
    cachedSettings = loadNarrationSettings();
  }
  return cachedSettings;
}

function getServerSnapshot(): NarrationSettings {
  return DEFAULT_NARRATION_SETTINGS;
}

/** Re-renders subscribers when another tab changes the stored settings. */
function onStorage(event: StorageEvent): void {
  // A null key means storage was cleared.
  if (event.key === STORAGE_KEY || event.key === null) {
    subscribers.forEach((callback) => callback());
  }
}

function subscribe(callback: () => void): () => void {
  if (subscribers.size === 0) window.addEventListener("storage", onStorage);
  subscribers.add(callback);
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0) window.removeEventListener("storage", onStorage);
  };
}

const setNarrationSettings: SetNarrationSettings = (settingsOrUpdater) => {
  const next =
    typeof settingsOrUpdater === "function" ? settingsOrUpdater(getSnapshot()) : settingsOrUpdater;
  saveNarrationSettings(next);
  // Cache the value itself rather than re-parsing storage, so the new settings
  // hold for this session even if localStorage is full or unavailable.
  cachedRaw = readRaw();
  cachedSettings = next;
  subscribers.forEach((callback) => callback());
};

/**
 * React hook for managing narration settings.
 *
 * Reads a module-level store through useSyncExternalStore, so every caller
 * shares one value and the server/hydration render always sees the defaults
 * (the stored settings apply right after hydration — see src/CLAUDE.md).
 * The setter persists to localStorage and supports both direct values and
 * functional updates (like React's useState).
 *
 * @returns A tuple of [settings, setSettings].
 *
 * @example
 * ```tsx
 * function NarrationControls() {
 *   const [settings, setSettings] = useNarrationSettings();
 *
 *   // Direct update
 *   setSettings({ ...settings, voiceId: 'some-voice' });
 *
 *   // Functional update (preferred for callbacks to avoid stale closures)
 *   setSettings((prev) => ({ ...prev, voiceId: 'some-voice' }));
 * }
 * ```
 */
export function useNarrationSettings(): [NarrationSettings, SetNarrationSettings] {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return [settings, setNarrationSettings];
}
