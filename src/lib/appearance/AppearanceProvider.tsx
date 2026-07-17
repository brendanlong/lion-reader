/**
 * AppearanceProvider Component
 *
 * Provides text appearance settings context (font, size, justification).
 * Theme (dark/light mode) is handled by next-themes at the root layout level.
 */

"use client";

import { createContext, useContext, useEffect, useCallback, useMemo, type ReactNode } from "react";
import { useTheme } from "next-themes";
import { useAppearanceSettings, type AppearanceSettings } from "./settings";
import { entryTextStyleVars } from "./config";

interface AppearanceContextValue {
  settings: AppearanceSettings;
  updateSettings: (settings: Partial<AppearanceSettings>) => void;
  /** The resolved theme (never "system"). Undefined during SSR. */
  resolvedTheme: "light" | "dark" | "epaper" | undefined;
  /** Set the theme ("light", "dark", "epaper", or "system") */
  setTheme: (theme: string) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

interface AppearanceProviderProps {
  children: ReactNode;
}

export function AppearanceProvider({ children }: AppearanceProviderProps) {
  const [settings, setSettings] = useAppearanceSettings();
  const { resolvedTheme, setTheme } = useTheme();

  const updateSettings = useCallback(
    (partial: Partial<AppearanceSettings>) => {
      setSettings({ ...settings, ...partial });
    },
    [settings, setSettings]
  );

  const value = useMemo(
    () => ({
      settings,
      updateSettings,
      resolvedTheme: resolvedTheme as "light" | "dark" | "epaper" | undefined,
      setTheme,
    }),
    [settings, updateSettings, resolvedTheme, setTheme]
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
 *
 * Uses CSS custom properties set by the head script for initial render to avoid
 * flash of wrong styles during hydration. The React state is still tracked to
 * update the CSS vars when settings change. The vars come from the shared
 * `entryTextStyleVars` (the same mapping the head script bakes in), so runtime
 * updates and the pre-paint values can't diverge.
 */
export function useEntryTextStyles(): {
  className: string;
  style: React.CSSProperties;
} {
  const { settings } = useAppearance();

  // Update CSS custom properties when settings change (for client-side updates)
  useEffect(() => {
    const style = document.documentElement.style;
    for (const [prop, value] of Object.entries(entryTextStyleVars(settings))) {
      style.setProperty(prop, value);
    }
  }, [settings]);

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
