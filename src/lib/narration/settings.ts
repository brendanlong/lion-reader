/**
 * Narration settings management.
 *
 * Provides utilities for loading, saving, and managing narration preferences
 * including voice selection, playback rate, and pitch.
 */

"use client";

import { useSyncExternalStore } from "react";
import { z } from "zod";
import { storeChangedFields } from "@/lib/stored-preference";
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
   * - "browser": Native Web Speech API voices
   * - "phonon": Downloaded voices via Phonon (requires download)
   * - "cloud": Cloud voices (server-side speech models; default)
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
   * For Phonon: a voice id from `ENHANCED_VOICES`.
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
   * Whether narration goes on to the next article in the list when one ends.
   * Default: true
   */
  continueToNextArticle: boolean;

  /**
   * Whether to use LLM preprocessing for narration.
   * When enabled, content is processed by an LLM to improve TTS quality
   * (expanding abbreviations, formatting URLs, etc.).
   * When disabled, uses simple HTML-to-text conversion.
   * Default: false
   */
  useLlmNormalization: boolean;

  /** Silence between sentences with enhanced voices, in seconds (0 to 1). */
  sentenceGapSeconds: number;

  /** Silence after each chunk of cloud speech, in seconds. */
  cloudPauseSeconds: number;
}

/**
 * Default narration settings.
 */
export const DEFAULT_NARRATION_SETTINGS: NarrationSettings = {
  enabled: true,
  provider: "cloud",
  cloudModelId: null,
  voiceId: null,
  rate: DEFAULT_RATE,
  pitch: DEFAULT_PITCH,
  highlightEnabled: true,
  autoScrollEnabled: true,
  continueToNextArticle: true,
  useLlmNormalization: false,
  sentenceGapSeconds: 0.1,
  cloudPauseSeconds: DEFAULT_CLOUD_SPEECH_PAUSE_SECONDS,
};

/**
 * localStorage key for narration settings.
 */
const STORAGE_KEY = "lion-reader-narration-settings";

const D = DEFAULT_NARRATION_SETTINGS;

/**
 * Stored settings, field by field: a field that's missing or invalid (an
 * older version's, or a hand edit) takes its default, and the rest survive.
 */
const storedSettingsSchema: z.ZodType<NarrationSettings, unknown> = z
  .object({
    enabled: z.boolean().catch(D.enabled),
    provider: z.enum(TTS_PROVIDER_IDS).catch(D.provider),
    cloudModelId: z.string().nullable().catch(null),
    voiceId: z.string().nullable().catch(null),
    rate: z.number().min(MIN_RATE).max(MAX_RATE).catch(D.rate),
    pitch: z.number().min(MIN_PITCH).max(MAX_PITCH).catch(D.pitch),
    highlightEnabled: z.boolean().catch(D.highlightEnabled),
    autoScrollEnabled: z.boolean().catch(D.autoScrollEnabled),
    continueToNextArticle: z.boolean().catch(D.continueToNextArticle),
    useLlmNormalization: z.boolean().catch(D.useLlmNormalization),
    sentenceGapSeconds: z.number().min(0).max(1).catch(D.sentenceGapSeconds),
    cloudPauseSeconds: z
      .number()
      .min(0)
      .max(MAX_CLOUD_SPEECH_PAUSE_SECONDS)
      .catch(D.cloudPauseSeconds),
  })
  .catch(D);

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

    return storedSettingsSchema.parse(JSON.parse(stored));
  } catch {
    // If parsing fails, return defaults
    return DEFAULT_NARRATION_SETTINGS;
  }
}

/**
 * The provider narration uses: built-in voices instead of cloud ones when the
 * browser can't stream audio, or `narration.listVoiceModels` lists none for
 * the user (no provider key, or a plan without them) or fails (the server
 * can't be reached, so neither could cloud voices). Until it answers, the
 * choice stands.
 */
export function narrationProvider(
  provider: TTSProviderId,
  cloudVoices: { data?: { models: unknown[] }; isError: boolean },
  canStreamAudio: boolean
): TTSProviderId {
  const unavailable =
    !canStreamAudio || cloudVoices.isError || cloudVoices.data?.models.length === 0;
  return provider === "cloud" && unavailable ? "browser" : provider;
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
  const prev = getSnapshot();
  const next =
    typeof settingsOrUpdater === "function" ? settingsOrUpdater(prev) : settingsOrUpdater;
  storeChangedFields(STORAGE_KEY, prev, next);
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
 * The setter persists to localStorage only the fields it changes, so the
 * rest keep following their defaults, and supports both direct values and
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
