import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono, Merriweather, Literata, Inter, Source_Sans_3 } from "next/font/google";
import { defaultOpenGraph } from "@/lib/metadata";
import { appUrl } from "@/server/config/env";
import { ThemeProvider } from "@/lib/theme/ThemeProvider";
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

export const metadata: Metadata = {
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
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#18181b" },
  ],
};

/**
 * Blocking script to apply text appearance settings before first paint.
 *
 * This runs synchronously in the <head> to prevent flash of wrong text size/font.
 * Must be kept in sync with settings.ts storage key and logic.
 *
 * Note: Theme (dark/light mode) is handled by next-themes, not this script.
 *
 * Sets CSS custom properties for text appearance:
 * - --entry-font-family
 * - --entry-font-size
 * - --entry-line-height
 * - --entry-text-align
 */
const textAppearanceScript = `
(function() {
  try {
    var stored = localStorage.getItem('lion-reader-appearance-settings');
    var settings = {
      textSize: 'medium',
      fontFamily: 'system',
      textJustification: 'left'
    };
    if (stored) {
      var parsed = JSON.parse(stored);
      if (['small', 'medium', 'large', 'x-large'].indexOf(parsed.textSize) >= 0) {
        settings.textSize = parsed.textSize;
      }
      if (['system', 'merriweather', 'literata', 'inter', 'source-sans'].indexOf(parsed.fontFamily) >= 0) {
        settings.fontFamily = parsed.fontFamily;
      }
      if (parsed.textJustification === 'justify') {
        settings.textJustification = 'justify';
      }
    }

    // Font configs with size adjustments for visual consistency
    var fontConfigs = {
      'system': { family: 'inherit', sizeAdjust: 1, lineHeight: 1.7 },
      'merriweather': { family: 'var(--font-merriweather), Georgia, serif', sizeAdjust: 0.929, lineHeight: 1.8 },
      'literata': { family: 'var(--font-literata), Georgia, serif', sizeAdjust: 1, lineHeight: 1.75 },
      'inter': { family: 'var(--font-inter), system-ui, sans-serif', sizeAdjust: 0.945, lineHeight: 1.7 },
      'source-sans': { family: 'var(--font-source-sans), system-ui, sans-serif', sizeAdjust: 1.061, lineHeight: 1.7 }
    };
    var baseSizes = { 'small': 0.875, 'medium': 1, 'large': 1.125, 'x-large': 1.25 };

    var fontConfig = fontConfigs[settings.fontFamily] || fontConfigs['system'];
    var baseSize = baseSizes[settings.textSize] || 1;
    var adjustedSize = baseSize * fontConfig.sizeAdjust;

    // Set CSS custom properties for entry text styling
    var style = document.documentElement.style;
    style.setProperty('--entry-font-family', fontConfig.family);
    style.setProperty('--entry-font-size', adjustedSize + 'rem');
    style.setProperty('--entry-line-height', fontConfig.lineHeight);
    style.setProperty('--entry-text-align', settings.textJustification);
  } catch (e) {}
})();
`;

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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Per-request CSP nonce, generated in src/proxy.ts (issue #1275). Every
  // inline <script> must carry it or the CSP blocks the script — that includes
  // next-themes' theme script, which gets it via ThemeProvider below. Absent
  // only if the proxy didn't run, in which case the response has no CSP either.
  //
  // The announcement banner is deliberately NOT rendered here: it lives in the
  // authenticated SPA layout (src/app/(app)/layout.tsx) so a temporary message
  // is never baked into the CDN-cached public pages (see src/server/http/page-cache.ts).
  const headerStore = await headers();
  const nonce = headerStore.get("x-nonce") ?? undefined;

  return (
    // Font variables live on <html> (not <body>) so the entry text-appearance
    // custom properties, which are set on documentElement by the head script
    // and useEntryTextStyles, can resolve nested var(--font-*) references.
    // Setting them on <body> left --entry-font-family invalid at the html level,
    // which broke font selection for entry content everywhere. next-themes only
    // toggles the theme class on <html>, so these classes are preserved.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${merriweather.variable} ${literata.variable} ${inter.variable} ${sourceSans.variable}`}
    >
      <head>
        {/* suppressHydrationWarning: browsers blank the nonce content attribute
            after parsing (nonce hiding), so hydration would see nonce="" and
            warn on every load. The scripts have executed by then either way. */}
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
