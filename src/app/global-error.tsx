"use client";

/**
 * Global Error Component
 *
 * Shown when an unhandled error occurs in the root layout. It captures errors
 * with Sentry and provides a fallback UI.
 *
 * This page must theme itself (issue #1350): Next renders it as a complete
 * document, replacing the root layout — so the blocking theme script and
 * `globals.css` may be gone, or the stylesheet may have failed to load
 * entirely. The old version rendered a default-white page, which flashed
 * bright for dark-mode users whenever a page's hydration failed. Colors
 * therefore live in an inline <style> (CSP `style-src` allows
 * `'unsafe-inline'`) keyed off `prefers-color-scheme`, refined by the stored
 * theme on the first client render.
 *
 * https://nextjs.org/docs/app/building-your-application/routing/error-handling
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEME_STORAGE_KEY, THEMES } from "@/lib/theme/config";

/**
 * Self-contained palette: light by default, dark via media query, with the
 * explicit theme classes (set from localStorage on first client render)
 * overriding the media query. Values mirror the canvas/text/primary tokens in
 * globals.css but are deliberately hardcoded — this page must not depend on
 * any external CSS.
 */
const styles = `
  :root { --ge-bg: #fafafa; --ge-fg: #3f3f46; --ge-muted: #52525b; --ge-btn: #b45309; --ge-btn-fg: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --ge-bg: #09090b; --ge-fg: #d4d4d8; --ge-muted: #a1a1aa; --ge-btn: #f59e0b; --ge-btn-fg: #18181b; }
  }
  :root.light, :root.epaper { --ge-bg: #fafafa; --ge-fg: #3f3f46; --ge-muted: #52525b; --ge-btn: #b45309; --ge-btn-fg: #ffffff; }
  :root.epaper { --ge-bg: #ffffff; --ge-fg: #000000; --ge-btn: #000000; --ge-btn-fg: #ffffff; }
  :root.dark { --ge-bg: #09090b; --ge-fg: #d4d4d8; --ge-muted: #a1a1aa; --ge-btn: #f59e0b; --ge-btn-fg: #18181b; }
  body { margin: 0; background: var(--ge-bg); color: var(--ge-fg); }
`;

/** The stored theme, or null when unset/invalid ("system" resolves via the media query). */
function storedTheme(): string | null {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY) ?? DEFAULT_THEME;
    return (THEMES as readonly string[]).includes(stored) ? stored : null;
  } catch {
    return null;
  }
}

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // Lazy initializer: on the client this applies the stored theme on the very
  // first render; in an SSR'd error render it returns null (storage access
  // throws → caught) and the prefers-color-scheme fallback in `styles`
  // applies, then the client initializer refines it (an accepted hydration
  // mismatch in an already-broken document).
  const [theme] = useState(storedTheme);

  useEffect(() => {
    // Report error to Sentry
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className={theme ?? undefined} suppressHydrationWarning>
      <body>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            padding: "2rem",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <h1 style={{ fontSize: "1.5rem", fontWeight: "bold", marginBottom: "1rem" }}>
            Something went wrong
          </h1>
          <p
            style={{
              color: "var(--ge-muted)",
              marginBottom: "1.5rem",
              textAlign: "center",
            }}
          >
            An unexpected error occurred. Our team has been notified.
          </p>
          <button
            onClick={() => reset()}
            style={{
              padding: "0.75rem 1.5rem",
              backgroundColor: "var(--ge-btn)",
              color: "var(--ge-btn-fg)",
              border: "none",
              borderRadius: "0.375rem",
              cursor: "pointer",
              fontSize: "1rem",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
