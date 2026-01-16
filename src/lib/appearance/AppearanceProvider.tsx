/**
 * AppearanceProvider Component
 *
 * Provides appearance settings context and applies theme to the document.
 * - Manages the `dark` class on `<html>` for theme switching
 * - Provides settings to child components via context
 */

"use client";

import { createContext, useContext, useEffect, useCallback, useMemo, type ReactNode } from "react";
import {
  useAppearanceSettings,
  type AppearanceSettings,
  type ThemeMode,
  type TextSize,
  type FontFamily,
} from "./settings";

interface AppearanceContextValue {
  settings: AppearanceSettings;
  updateSettings: (settings: Partial<AppearanceSettings>) => void;
  /** The resolved theme (always "light" or "dark", never "auto") */
  resolvedTheme: "light" | "dark";
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

interface AppearanceProviderProps {
  children: ReactNode;
}

/**
 * Determines the resolved theme based on mode and system preference.
 */
function getResolvedTheme(mode: ThemeMode): "light" | "dark" {
  if (mode === "auto") {
    if (typeof window === "undefined") {
      return "light"; // SSR default
    }
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

export function AppearanceProvider({ children }: AppearanceProviderProps) {
  const [settings, setSettings] = useAppearanceSettings();

  // Track system preference changes for auto mode
  useEffect(() => {
    if (settings.themeMode !== "auto") return;

    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

    const handleChange = () => {
      // Force re-render to update resolvedTheme
      setSettings({ ...settings });
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, [settings, setSettings]);

  // Apply theme class to document
  useEffect(() => {
    const resolved = getResolvedTheme(settings.themeMode);
    const html = document.documentElement;

    if (resolved === "dark") {
      html.classList.add("dark");
    } else {
      html.classList.remove("dark");
    }
  }, [settings.themeMode]);

  const resolvedTheme = useMemo(() => getResolvedTheme(settings.themeMode), [settings.themeMode]);

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
