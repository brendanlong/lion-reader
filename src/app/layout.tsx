import type { Metadata } from "next";
import { Geist, Geist_Mono, Merriweather, Literata, Inter, Source_Sans_3 } from "next/font/google";
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
  title: "Lion Reader",
  description: "A modern feed reader",
  icons: {
    icon: [
      { url: "/favicon-16x16.png", sizes: "16x16", type: "image/png" },
      { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

/**
 * Blocking script to apply theme before first paint.
 *
 * This runs synchronously in the <head> to prevent flash of wrong theme.
 * Must be kept in sync with settings.ts storage key and logic.
 */
const themeScript = `
(function() {
  try {
    var stored = localStorage.getItem('lion-reader-appearance-settings');
    var mode = 'auto';
    if (stored) {
      var parsed = JSON.parse(stored);
      if (parsed.themeMode === 'light' || parsed.themeMode === 'dark') {
        mode = parsed.themeMode;
      }
    }
    var dark = mode === 'dark' || (mode === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} ${merriweather.variable} ${literata.variable} ${inter.variable} ${sourceSans.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
