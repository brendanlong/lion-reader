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
 * Hook to get text style classes for entry content.
 *
 * Returns Tailwind classes and inline styles for applying text appearance settings.
 */
export function useEntryTextStyles(): {
  className: string;
  style: React.CSSProperties;
} {
  const { settings } = useAppearance();

  return useMemo(() => {
    // Text size class
    const sizeClasses: Record<TextSize, string> = {
      small: "prose-sm",
      medium: "prose-base",
      large: "prose-lg",
      "x-large": "prose-xl",
    };

    // Font family CSS
    const fontFamilies: Record<FontFamily, string> = {
      system: "inherit",
      serif: "Georgia, 'Times New Roman', Times, serif",
      "sans-serif": "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    };

    const className = sizeClasses[settings.textSize] || "prose-base";

    const style: React.CSSProperties = {
      fontFamily: fontFamilies[settings.fontFamily] || "inherit",
      textAlign: settings.textJustification === "justify" ? "justify" : "left",
    };

    return { className, style };
  }, [settings.textSize, settings.fontFamily, settings.textJustification]);
}
