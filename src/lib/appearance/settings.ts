/**
 * Appearance settings management.
 *
 * Provides utilities for loading, saving, and managing text appearance preferences
 * including text size, text justification, and font family.
 *
 * Note: Theme (dark/light mode) is managed separately by next-themes.
 */

"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Text size options for entry content.
 */
export type TextSize = "small" | "medium" | "large" | "x-large";

/**
 * Text justification options for entry content.
 */
export type TextJustification = "left" | "justify";

/**
 * Font family options for entry content.
 */
export type FontFamily = "system" | "merriweather" | "literata" | "inter" | "source-sans";

/**
 * User preferences for text appearance.
 *
 * Note: Theme (dark/light mode) is managed by next-themes, not here.
 */
export interface AppearanceSettings {
  /**
   * Text size for entry content.
   */
  textSize: TextSize;

  /**
   * Text justification for entry content.
   */
  textJustification: TextJustification;

  /**
   * Font family for entry content.
   */
  fontFamily: FontFamily;
}

/**
 * Default appearance settings.
 */
export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  textSize: "medium",
  textJustification: "left",
  fontFamily: "system",
};

/**
 * localStorage key for appearance settings.
 */
const STORAGE_KEY = "lion-reader-appearance-settings";

/**
 * Loads appearance settings from localStorage.
 *
 * Returns the saved settings merged with defaults (in case new fields
 * are added in future versions). Returns defaults if no saved settings
 * exist or if localStorage is unavailable.
 *
 * @returns The loaded appearance settings.
 */
export function loadAppearanceSettings(): AppearanceSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APPEARANCE_SETTINGS;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return DEFAULT_APPEARANCE_SETTINGS;
    }

    const parsed = JSON.parse(stored) as Partial<AppearanceSettings>;

    // Validate and merge with defaults
    const validTextSizes: TextSize[] = ["small", "medium", "large", "x-large"];
    const validJustifications: TextJustification[] = ["left", "justify"];
    const validFontFamilies: FontFamily[] = [
      "system",
      "merriweather",
      "literata",
      "inter",
      "source-sans",
    ];

    return {
      textSize: validTextSizes.includes(parsed.textSize as TextSize)
        ? (parsed.textSize as TextSize)
        : DEFAULT_APPEARANCE_SETTINGS.textSize,
      textJustification: validJustifications.includes(parsed.textJustification as TextJustification)
        ? (parsed.textJustification as TextJustification)
        : DEFAULT_APPEARANCE_SETTINGS.textJustification,
      fontFamily: validFontFamilies.includes(parsed.fontFamily as FontFamily)
        ? (parsed.fontFamily as FontFamily)
        : DEFAULT_APPEARANCE_SETTINGS.fontFamily,
    };
  } catch {
    // If parsing fails, return defaults
    return DEFAULT_APPEARANCE_SETTINGS;
  }
}

/**
 * Saves appearance settings to localStorage.
 *
 * @param settings - The settings to save.
 */
export function saveAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Silently fail if localStorage is full or unavailable
  }
}

// Subscribers for settings changes
const subscribers = new Set<() => void>();

// Cached snapshot for useSyncExternalStore (must return same reference if unchanged)
let cachedSnapshot: AppearanceSettings | null = null;

// Notify all subscribers when settings change
function notifySubscribers() {
  // Invalidate cache so next getSnapshot reads fresh data
  cachedSnapshot = null;
  subscribers.forEach((callback) => callback());
}

// Subscribe function for useSyncExternalStore
function subscribe(callback: () => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

// Get snapshot for client (cached to avoid infinite loop)
function getSnapshot(): AppearanceSettings {
  if (cachedSnapshot === null) {
    cachedSnapshot = loadAppearanceSettings();
  }
  return cachedSnapshot;
}

// Get snapshot for server (always returns defaults)
function getServerSnapshot(): AppearanceSettings {
  return DEFAULT_APPEARANCE_SETTINGS;
}

/**
 * React hook for managing appearance settings.
 *
 * Uses useSyncExternalStore to properly handle SSR/hydration.
 * Returns defaults on server, loads from localStorage on client.
 *
 * @returns A tuple of [settings, setSettings].
 */
export function useAppearanceSettings(): [
  AppearanceSettings,
  (settings: AppearanceSettings) => void,
] {
  const settings = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Save and update settings, then notify subscribers
  const setSettings = useCallback((newSettings: AppearanceSettings) => {
    saveAppearanceSettings(newSettings);
    notifySubscribers();
  }, []);

  return [settings, setSettings];
}
