/**
 * Theme Provider
 *
 * Wraps next-themes ThemeProvider with our preferred configuration.
 * Handles dark/light mode switching with system preference support.
 */

"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Theme provider that wraps the app with next-themes.
 *
 * Configuration:
 * - attribute="class": Uses .dark class on <html> (matches our Tailwind config)
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
      disableTransitionOnChange
      storageKey="lion-reader-theme"
    >
      {children}
    </NextThemesProvider>
  );
}
