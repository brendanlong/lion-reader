"use client";

/**
 * Reports that an entry was opened.
 *
 * Opening an entry doesn't change the pathname (the id lives in `?entry=`), so
 * `PageViewTracker` never sees it. This is the deliberate, separate report.
 *
 * In the app it reports the entry's **type** only — the only thing analytics
 * ever learns about what a signed-in person reads is that a web / email /
 * saved article was opened, never which one. Under the demo mount it reports
 * the article **id**: demo articles are dev-authored marketing content in this
 * repo — our own pages, not user data — so which one is read is safe to report
 * and is the most useful signal the public site produces. The id is still
 * allowlisted rather than passed through (`analyticsPathForDemoEntry`).
 *
 * Keyed on the entry id so switching entries counts again.
 */

import { useEffect, useRef } from "react";
import { useRouteBase } from "@/lib/hooks/useAppLocation";
import { DEMO_BASE_PATH } from "@/lib/routes";
import { trackPageView } from "./beacon";
import { analyticsPathForDemoEntry, analyticsPathForEntry, type EntryKind } from "./paths";

export function useTrackEntryView(entryId: string | undefined, kind: EntryKind | undefined): void {
  const reported = useRef<string | null>(null);
  const isDemo = useRouteBase() === DEMO_BASE_PATH;

  useEffect(() => {
    // Wait for the entry to actually load: callers render a fallback first, and
    // prefetched neighbours must not be counted as views.
    if (!entryId || !kind || reported.current === entryId) return;
    reported.current = entryId;
    trackPageView(isDemo ? analyticsPathForDemoEntry(entryId) : analyticsPathForEntry(kind));
  }, [entryId, kind, isDemo]);
}
