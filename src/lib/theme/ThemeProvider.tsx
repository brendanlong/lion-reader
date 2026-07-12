/**
 * Theme Provider
 *
 * Wraps next-themes ThemeProvider with our preferred configuration.
 * Handles dark/light/e-paper mode switching with system preference support.
 */

"use client";

import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes";
import { useEffect, type ReactNode } from "react";
import { useIsEInkDisplay } from "./eink";

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Resolves the "system" theme to e-paper on e-ink displays (issue #1017).
 *
 * next-themes only knows how to resolve "system" to light/dark via
 * `prefers-color-scheme`, so this component re-asserts the `epaper` class on
 * <html> whenever the user is on Auto and the display looks like an e-reader.
 * A MutationObserver (rather than a plain effect) is required because
 * next-themes applies its theme class from the provider's own effect, which
 * runs *after* child effects — and also re-applies it imperatively on system
 * preference changes. When the user picks an explicit theme, next-themes
 * removes the `epaper` class itself (it's in the configured themes list).
 */
function EInkSystemThemeOverride() {
  const { theme } = useTheme();
  const isEInk = useIsEInkDisplay();
  const active = isEInk && theme === "system";

  useEffect(() => {
    if (!active) {
      return;
    }
    const root = document.documentElement;
    const apply = () => {
      // Only mutate when needed so the observer doesn't loop on its own writes
      if (
        root.classList.contains("light") ||
        root.classList.contains("dark") ||
        !root.classList.contains("epaper")
      ) {
        root.classList.remove("light", "dark");
        root.classList.add("epaper");
      }
      // next-themes writes the resolved system theme's color-scheme as an
      // inline style (e.g. "dark" when the OS prefers dark), which would beat
      // the `.epaper { color-scheme: light }` rule. It always rewrites this
      // together with the class, so re-asserting here covers every path; when
      // the user later picks an explicit theme, next-themes overwrites or
      // clears it again.
      if (root.style.colorScheme !== "light") {
        root.style.colorScheme = "light";
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [active]);

  return null;
}

/**
 * Theme provider that wraps the app with next-themes.
 *
 * Configuration:
 * - attribute="class": Uses .dark/.light/.epaper class on <html> (matches our Tailwind config)
 * - themes: light/dark plus the e-paper theme for e-ink screens ("system" is
 *   appended automatically because enableSystem is set)
 * - defaultTheme="system": Follows system preference by default
 * - enableSystem: Allows "system" as a theme option
 * - disableTransitionOnChange: Prevents flash by disabling CSS transitions during theme change
 * - storageKey: Uses our existing localStorage key for backwards compatibility
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      themes={["light", "dark", "epaper"]}
      disableTransitionOnChange
      storageKey="lion-reader-theme"
    >
      <EInkSystemThemeOverride />
      {children}
    </NextThemesProvider>
  );
}
