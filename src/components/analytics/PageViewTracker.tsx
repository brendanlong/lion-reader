"use client";

/**
 * Reports a page view on first render and on every route change.
 *
 * Lives in the shared document shell (`src/app/root-document.tsx`) so both root
 * layouts get it — unlike the third-party script it replaces, there is no
 * route it must be kept away from: it reports only constants from the closed
 * vocabulary in `@/lib/analytics/paths`, so `/register` is counted without its
 * invite token ever leaving the browser.
 *
 * Keyed on `usePathname()`, which updates on the `pushState` navigation the SPA
 * and the demo use. It deliberately ignores the query string, so opening an
 * entry (`?entry=<id>`) is not a page view here — that is reported separately
 * and by type only, via `useTrackEntryView`.
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { trackPageView } from "@/lib/analytics/beacon";
import { analyticsPathForRoute } from "@/lib/analytics/paths";

export function PageViewTracker() {
  const pathname = usePathname();
  // React 18 StrictMode double-invokes effects in dev, and a remount must not
  // double-count; track the last path actually reported.
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (reported.current === pathname) return;
    reported.current = pathname;
    const path = analyticsPathForRoute(pathname);
    if (path) trackPageView(path);
  }, [pathname]);

  return null;
}
