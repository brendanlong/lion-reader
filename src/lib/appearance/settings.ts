/**
 * Appearance settings management.
 *
 * Provides utilities for loading, saving, and managing text appearance preferences
 * including text size, text justification, and font family.
 *
 * Note: Theme (dark/light mode) is managed separately by next-themes.
 */

"use client";

import { createStoredJson, storeChangedFields } from "@/lib/stored-preference";
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

const appearanceSettings = createStoredJson<AppearanceSettings>(
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE_SETTINGS,
  (json) =>
    typeof json === "object" && json !== null
      ? coerceAppearanceSettings(json as Partial<AppearanceSettings>)
      : null,
  storeChangedFields
);

/** The appearance settings and their setter; defaults until hydrated. */
export function useAppearanceSettings(): [
  AppearanceSettings,
  (settings: AppearanceSettings) => void,
] {
  return [appearanceSettings.useValue(), appearanceSettings.set];
}
