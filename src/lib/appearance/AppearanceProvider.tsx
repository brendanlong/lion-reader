/**
 * AppearanceProvider Component
 *
 * Provides appearance settings context and applies theme to the document.
 * - Manages the `dark` class on `<html>` for theme switching
 * - Provides settings to child components via context
 */

"use client";

import {
  createContext,
  useContext,
  useEffect,
  useCallback,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  useAppearanceSettings,
  type AppearanceSettings,
  type TextSize,
  type FontFamily,
} from "./settings";

interface AppearanceContextValue {
  settings: AppearanceSettings;
  updateSettings: (settings: Partial<AppearanceSettings>) => void;
  /** The resolved theme (always "light" or "dark", never "auto"). Null during SSR. */
  resolvedTheme: "light" | "dark" | null;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

interface AppearanceProviderProps {
  children: ReactNode;
}

/**
 * Subscribe to system color scheme changes.
 */
function subscribeToSystemPreference(callback: () => void): () => void {
  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  mediaQuery.addEventListener("change", callback);
  return () => mediaQuery.removeEventListener("change", callback);
}

/**
 * Get current system preference (client only).
 */
function getSystemPreference(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/**
 * Server snapshot - return null to indicate SSR.
 */
function getServerSystemPreference(): boolean | null {
  return null;
}

/**
 * Hook to track system color scheme preference.
 * Returns true for dark, false for light, null during SSR.
 */
function useSystemPreference(): boolean | null {
  return useSyncExternalStore(
    subscribeToSystemPreference,
    getSystemPreference,
    getServerSystemPreference
  );
}

export function AppearanceProvider({ children }: AppearanceProviderProps) {
  const [settings, setSettings] = useAppearanceSettings();
  const systemPrefersDark = useSystemPreference();

  // Compute resolved theme based on mode and system preference
  const resolvedTheme = useMemo((): "light" | "dark" | null => {
    if (settings.themeMode === "auto") {
      // During SSR, return null (we don't know system preference)
      if (systemPrefersDark === null) return null;
      return systemPrefersDark ? "dark" : "light";
    }
    return settings.themeMode;
  }, [settings.themeMode, systemPrefersDark]);

  // Apply theme class to document
  useEffect(() => {
    if (resolvedTheme === null) return; // SSR, do nothing

    const html = document.documentElement;
    if (resolvedTheme === "dark") {
      html.classList.add("dark");
    } else {
      html.classList.remove("dark");
    }
  }, [resolvedTheme]);

  const updateSettings = useCallback(
    (partial: Partial<AppearanceSettings>) => {
      setSettings({ ...settings, ...partial });
    },
    [settings, setSettings]
  );

  const value = useMemo(
    () => ({ settings, updateSettings, resolvedTheme }),
    [settings, updateSettings, resolvedTheme]
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

/**
 * Hook to access appearance settings and update functions.
 *
 * @throws Error if used outside of AppearanceProvider
 */
export function useAppearance(): AppearanceContextValue {
  const context = useContext(AppearanceContext);
  if (!context) {
    throw new Error("useAppearance must be used within an AppearanceProvider");
  }
  return context;
}

/**
 * Font configuration with normalized sizing.
 *
 * Different fonts have different x-heights and metrics, so they appear
 * different sizes at the same font-size. We apply size adjustments and
 * tuned line-heights to make them visually consistent.
 */
interface FontConfig {
  family: string;
  /** Size multiplier to normalize apparent size (1 = baseline) */
  sizeAdjust: number;
  /** Line height tuned for this font */
  lineHeight: number;
}

const FONT_CONFIGS: Record<FontFamily, FontConfig> = {
  system: {
    family: "inherit",
    // Varies by platform (San Francisco, Segoe UI, Roboto, etc.)
    sizeAdjust: 1,
    lineHeight: 1.7,
  },
  merriweather: {
    family: "var(--font-merriweather), Georgia, serif",
    // Smaller x-height, scale up to match Literata baseline
    sizeAdjust: 0.929,
    lineHeight: 1.8,
  },
  literata: {
    family: "var(--font-literata), Georgia, serif",
    // Baseline reference font
    sizeAdjust: 1,
    lineHeight: 1.75,
  },
  inter: {
    family: "var(--font-inter), system-ui, sans-serif",
    // Slightly smaller x-height than Literata
    sizeAdjust: 0.945,
    lineHeight: 1.7,
  },
  "source-sans": {
    family: "var(--font-source-sans), system-ui, sans-serif",
    // Larger x-height, scale down to match
    sizeAdjust: 1.061,
    lineHeight: 1.7,
  },
};

/**
 * Hook to get text style classes for entry content.
 *
 * Returns Tailwind classes and inline styles for applying text appearance settings.
 *
 * Uses CSS custom properties set by the head script for initial render to avoid
 * flash of wrong styles during hydration. The React state is still tracked to
 * update the CSS vars when settings change.
 */
export function useEntryTextStyles(): {
  className: string;
  style: React.CSSProperties;
} {
  const { settings } = useAppearance();

  // Update CSS custom properties when settings change (for client-side updates)
  useEffect(() => {
    const baseSizes: Record<TextSize, number> = {
      small: 0.875,
      medium: 1,
      large: 1.125,
      "x-large": 1.25,
    };

    const fontConfig = FONT_CONFIGS[settings.fontFamily] || FONT_CONFIGS.system;
    const baseSize = baseSizes[settings.textSize] || baseSizes.medium;
    const adjustedSize = baseSize * fontConfig.sizeAdjust;

    const style = document.documentElement.style;
    style.setProperty("--entry-font-family", fontConfig.family);
    style.setProperty("--entry-font-size", `${adjustedSize}rem`);
    style.setProperty("--entry-line-height", String(fontConfig.lineHeight));
    style.setProperty(
      "--entry-text-align",
      settings.textJustification === "justify" ? "justify" : "left"
    );
  }, [settings.textSize, settings.fontFamily, settings.textJustification]);

  // Return styles that use CSS custom properties (set by head script on initial load)
  return useMemo(
    () => ({
      className: "prose prose-zinc dark:prose-invert",
      style: {
        fontFamily: "var(--entry-font-family, inherit)",
        fontSize: "var(--entry-font-size, 1rem)",
        lineHeight: "var(--entry-line-height, 1.7)",
        textAlign: "var(--entry-text-align, left)" as React.CSSProperties["textAlign"],
      },
    }),
    []
  );
}
