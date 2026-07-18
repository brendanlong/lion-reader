/**
 * Shared root document for the two root layouts (issue #1359).
 *
 * The app has two root layouts, split by rendering mode:
 *
 * - `(spa)/layout.tsx` — the authenticated app and every auth/OAuth/utility
 *   surface. Dynamic (per-request SSR): it reads the per-request CSP nonce
 *   (issue #1275) and threads it to the inline scripts here, because those
 *   pages render sanitized-but-untrusted entry HTML and get the strict
 *   nonce-based CSP as an XSS backstop.
 * - `(public)/layout.tsx` — the public pages (demo, login, register, terms,
 *   privacy). Statically prerendered at build time so the origin serves them
 *   as cached files with near-zero CPU (the HN-flood landing pages). No nonce:
 *   these pages get the relaxed static CSP from `src/server/http/csp.ts`
 *   (`'unsafe-inline'`), which is safe because they render no user-supplied
 *   HTML — see SECURITY.md before adding any content to the public group.
 *
 * Everything document-level that both layouts share lives here — fonts,
 * metadata/viewport, the blocking theme/appearance scripts, the service-worker
 * registration — so the two can't drift. Only the nonce plumbing differs.
 *
 * Navigating between the two groups is a full page load (multiple root
 * layouts), which is fine: public↔app transitions are login/logout flows.
 */

import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Merriweather, Literata, Inter, Source_Sans_3 } from "next/font/google";
import { defaultOpenGraph } from "@/lib/metadata";
import { appUrl } from "@/server/config/env";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";
import { DEFAULT_THEME, THEME_STORAGE_KEY, THEMES } from "@/lib/theme/config";
import { buildTextAppearanceScript } from "@/lib/appearance/config";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Article content fonts
const merriweather = Merriweather({
  variable: "--font-merriweather",
  subsets: ["latin"],
  weight: ["300", "400", "700"],
});

const literata = Literata({
  variable: "--font-literata",
  subsets: ["latin"],
});

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
});

/**
 * Font-variable classes for <html>. Shared with `global-not-found.tsx`, which
 * must render its own complete document (it sits outside both root layouts).
 */
export const rootFontClassName = `${geistSans.variable} ${geistMono.variable} ${merriweather.variable} ${literata.variable} ${inter.variable} ${sourceSans.variable}`;

export const rootMetadata: Metadata = {
  metadataBase: new URL(appUrl),
  title: "Lion Reader",
  description:
    "An AI-native, all-in-one reader for RSS feeds, newsletters, and read-later — with MCP, summaries, and narration. Fast, open source, and self-hostable.",
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: defaultOpenGraph,
};

// SSR default for the mobile status-bar / PWA toolbar color, matching the
// `bg-surface` header per system preference. ThemeColorMeta (ThemeProvider) then
// overrides this to the *resolved app theme* after hydration, so a forced theme
// (e.g. dark on a light-scheme phone) still matches. See ThemeProvider.tsx.
export const rootViewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#18181b" },
  ],
};

/**
 * Blocking script to apply the theme class (dark/light/epaper) before first paint.
 *
 * next-themes injects its own theme script, but only where <ThemeProvider> is
 * mounted — inside <body>. That means <html> gets the theme class only after the
 * whole <head> is parsed, so a browser that paints the canvas background during
 * head parsing (Firefox notably) shows a light flash for a user who explicitly
 * chose dark on a light-scheme OS, on every full-page navigation (the demo/auth
 * pages use full document loads). The `@media (prefers-color-scheme)` fallback in
 * globals.css only covers *system*-theme users, not an explicit choice. Applying
 * the class here in <head>, before any body parsing, closes that gap; next-themes
 * re-asserts the identical class on hydration (idempotent, no visible change).
 *
 * The storageKey / themes / default come from the shared theme config (used by
 * ThemeProvider too) so the two can't drift; the resolution *logic* here still
 * mirrors next-themes' own inline script (the library doesn't export it), and
 * attribute=class / enableSystem must stay matched. The e-ink "system → epaper"
 * override is left to EInkSystemThemeOverride post-hydration, exactly as before.
 */
const themeScript = `
(function() {
  try {
    var themes = ${JSON.stringify(THEMES)};
    var stored = localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) || ${JSON.stringify(
      DEFAULT_THEME
    )};
    var resolved = themes.indexOf(stored) < 0 ? ${JSON.stringify(DEFAULT_THEME)} : stored;
    if (resolved === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    var el = document.documentElement;
    el.classList.remove.apply(el.classList, themes);
    el.classList.add(resolved);
    // next-themes sets color-scheme only for light/dark; .epaper declares its own
    // (color-scheme: light) in globals.css.
    if (resolved === 'light' || resolved === 'dark') {
      el.style.colorScheme = resolved;
    }
  } catch (e) {}
})();
`;

/**
 * Blocking script to apply text appearance settings before first paint.
 *
 * Runs synchronously in the <head> to prevent a flash of wrong text size/font.
 * Built from the shared appearance config (storage key, defaults, font metrics,
 * size formula) so it can't drift from the runtime store / useEntryTextStyles;
 * the appearance-head-script unit test pins its output to entryTextStyleVars.
 *
 * Note: Theme (dark/light mode) is handled by next-themes plus themeScript above.
 */
const textAppearanceScript = buildTextAppearanceScript();

/**
 * Service worker registration script.
 *
 * Registers the service worker for PWA support including:
 * - Share Target API (receiving shares from other apps)
 * - Basic caching for offline resilience
 */
const swScript = `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/sw.js').catch(function(err) {
      console.log('ServiceWorker registration failed:', err);
    });
  });
}
`;

interface RootDocumentProps {
  children: React.ReactNode;
  /**
   * Per-request CSP nonce for the (spa) layout's strict CSP; undefined for the
   * (public) layout, whose relaxed static CSP allows un-nonce'd inline scripts.
   */
  nonce?: string;
}

export function RootDocument({ children, nonce }: RootDocumentProps) {
  return (
    // Font variables live on <html> (not <body>) so the entry text-appearance
    // custom properties, which are set on documentElement by the head script
    // and useEntryTextStyles, can resolve nested var(--font-*) references.
    // Setting them on <body> left --entry-font-family invalid at the html level,
    // which broke font selection for entry content everywhere. next-themes only
    // toggles the theme class on <html>, so these classes are preserved.
    <html lang="en" suppressHydrationWarning className={rootFontClassName}>
      <head>
        {/* suppressHydrationWarning: browsers blank the nonce content attribute
            after parsing (nonce hiding), so hydration would see nonce="" and
            warn on every load. The scripts have executed by then either way. */}
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: textAppearanceScript }}
        />
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: swScript }}
        />
      </head>
      <body className="antialiased">
        <ThemeProvider nonce={nonce}>{children}</ThemeProvider>
      </body>
    </html>
  );
}
