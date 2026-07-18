"use client";

/**
 * Global Error Component
 *
 * Shown when an unhandled error occurs in the root layout. It captures errors
 * with Sentry and provides a fallback UI.
 *
 * Two hard constraints shape this file (issue #1350):
 *
 * 1. **It must theme itself.** Next renders this as a complete document,
 *    replacing the root layout — so the blocking theme script and `globals.css`
 *    may be gone, and in the most common trigger (CDN-cached HTML from a
 *    previous deploy whose hashed chunks now 404) the stylesheet may have
 *    failed to load entirely. The old version rendered a default-white page,
 *    which is exactly the "background flash" users saw in dark mode when a
 *    stale page's hydration failed mid-navigation. Colors therefore live in an
 *    inline <style> (CSP `style-src` allows `'unsafe-inline'`) keyed off
 *    `prefers-color-scheme`, refined by the stored theme after mount.
 *
 * 2. **It should try to heal before it alarms.** The stale-HTML chunk failure
 *    is fixed by a plain reload (browsers send `max-age=0`, so the reload
 *    fetches HTML matching the current deploy). We reload once per 30s
 *    (sessionStorage-guarded so a persistent error can't loop) and render only
 *    the themed background while doing so; the full "Something went wrong" UI
 *    only appears if the error survives the reload.
 *
 * https://nextjs.org/docs/app/building-your-application/routing/error-handling
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";
import { DEFAULT_THEME, THEME_STORAGE_KEY, THEMES } from "@/lib/theme/config";

const RELOAD_GUARD_KEY = "lion-reader-global-error-reload";
const RELOAD_GUARD_MS = 30_000;

/**
 * Self-contained palette: light by default, dark via media query, with the
 * explicit theme classes (set from localStorage after mount) overriding the
 * media query. Values mirror the canvas/text/primary tokens in globals.css but
 * are deliberately hardcoded — this page must not depend on any external CSS.
 */
const styles = `
  :root { --ge-bg: #fafafa; --ge-fg: #3f3f46; --ge-muted: #52525b; --ge-btn: #b45309; --ge-btn-fg: #ffffff; }
  @media (prefers-color-scheme: dark) {
    :root { --ge-bg: #09090b; --ge-fg: #d4d4d8; --ge-muted: #a1a1aa; --ge-btn: #f59e0b; --ge-btn-fg: #18181b; }
  }
  :root.light, :root.epaper { --ge-bg: #fafafa; --ge-fg: #3f3f46; --ge-muted: #52525b; --ge-btn: #b45309; --ge-btn-fg: #ffffff; }
  :root.epaper { --ge-bg: #ffffff; --ge-fg: #000000; --ge-btn: #000000; }
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
  // Decide synchronously (lazy initializer runs once, client-only) whether this
  // render should auto-reload, so the error UI never flashes before a reload.
  // Writing the guard here rather than in an effect keeps the decision and the
  // guard update atomic.
  const [reloading] = useState(() => {
    try {
      const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
      if (Date.now() - last > RELOAD_GUARD_MS) {
        sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
        return true;
      }
    } catch {}
    return false;
  });

  // Lazy initializer: on the client this applies the stored theme on the very
  // first render; in an SSR'd error render it returns null (storage access
  // throws → caught) and the prefers-color-scheme fallback in `styles` applies.
  const [theme] = useState(storedTheme);

  useEffect(() => {
    // Report error to Sentry
    Sentry.captureException(error);
  }, [error]);

  useEffect(() => {
    if (!reloading) return;
    // Small delay so the Sentry capture gets a chance to flush first.
    const t = setTimeout(() => window.location.reload(), 250);
    return () => clearTimeout(t);
  }, [reloading]);

  return (
    <html lang="en" className={theme ?? undefined} suppressHydrationWarning>
      <body>
        <style dangerouslySetInnerHTML={{ __html: styles }} />
        {!reloading && (
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
        )}
      </body>
    </html>
  );
}
