import type { Metadata } from "next";
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
  description: "A modern feed reader",
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
  openGraph: defaultOpenGraph,
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: textAppearanceScript }} />
        <script dangerouslySetInnerHTML={{ __html: swScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${merriweather.variable} ${literata.variable} ${inter.variable} ${sourceSans.variable} antialiased`}
      >
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  );
}
