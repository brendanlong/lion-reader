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
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_SETTINGS,
  coerceAppearanceSettings,
  type AppearanceSettings,
} from "./config";

// The appearance types and config are single-sourced in ./config (shared with
// the blocking <head> script in the root layout); re-exported here so existing
// `@/lib/appearance/settings` importers are unaffected.
export type {
  AppearanceSettings,
  TextSize,
  TextJustification,
  FontFamily,
  ListDensity,
} from "./config";

/**
 * Loads appearance settings from localStorage.
 *
 * Returns the saved settings merged with defaults (in case new fields
 * are added in future versions). Returns defaults if no saved settings
 * exist or if localStorage is unavailable.
 *
 * @returns The loaded appearance settings.
 */
function loadAppearanceSettings(): AppearanceSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APPEARANCE_SETTINGS;
  }

  try {
    const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_APPEARANCE_SETTINGS;
    }
    return coerceAppearanceSettings(JSON.parse(stored) as Partial<AppearanceSettings>);
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
function saveAppearanceSettings(settings: AppearanceSettings): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(settings));
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
