/**
 * Single source of truth for the theme config shared by the two places that must
 * resolve the theme identically:
 *
 * - the next-themes `<ThemeProvider>` (`src/lib/theme/ThemeProvider.tsx`), and
 * - the blocking `<head>` theme script in `src/app/layout.tsx`, which applies the
 *   theme class before first paint (next-themes' own script runs too late — it's
 *   inside `<body>`).
 *
 * If these drift, the head script and next-themes pick different classes and the
 * dark-mode flash the head script exists to prevent comes back on hydration. Keep
 * them wired to these constants rather than re-typing the literals.
 */

/** localStorage key next-themes persists the chosen theme under. */
export const THEME_STORAGE_KEY = "lion-reader-theme";

/**
 * The explicitly-selectable themes (map to `.light` / `.dark` / `.epaper` on
 * `<html>`). next-themes appends `"system"` itself because `enableSystem` is set.
 */
export const THEMES = ["light", "dark", "epaper"] as const;

/** Default when nothing is stored — follow the OS via `prefers-color-scheme`. */
export const DEFAULT_THEME = "system";
