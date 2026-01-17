/**
 * Appearance module exports.
 */

export {
  type ThemeMode,
  type TextSize,
  type TextJustification,
  type FontFamily,
  type AppearanceSettings,
  DEFAULT_APPEARANCE_SETTINGS,
  loadAppearanceSettings,
  saveAppearanceSettings,
  useAppearanceSettings,
} from "./settings";

export { AppearanceProvider, useAppearance, useEntryTextStyles } from "./AppearanceProvider";
