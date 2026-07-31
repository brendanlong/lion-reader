"use client";

/**
 * Reports that an entry was opened — as its **type** only.
 *
 * Opening an entry doesn't change the pathname (the id lives in `?entry=`), so
 * `PageViewTracker` never sees it. This is the deliberate, separate report, and
 * the only thing analytics ever learns about what a signed-in person reads:
 * that a web / email / saved article was opened, never which one.
 *
 * Keyed on the entry id so switching entries counts again, but the id itself is
 * only ever compared locally — `analyticsPathForEntry` takes the kind.
 */

import { useEffect, useRef } from "react";
import { trackPageView } from "./beacon";
import { analyticsPathForDemoEntry, analyticsPathForEntry, type EntryKind } from "./paths";

export function useTrackEntryView(entryId: string | undefined, kind: EntryKind | undefined): void {
  const reported = useRef<string | null>(null);

  useEffect(() => {
    // Wait for the entry to actually load: callers render a fallback first, and
    // prefetched neighbours must not be counted as views.
    if (!entryId || !kind || reported.current === entryId) return;
    reported.current = entryId;
    trackPageView(analyticsPathForEntry(kind));
  }, [entryId, kind]);
}

/**
 * Reports that a demo article was opened, by id.
 *
 * Separate from the app hook because demo articles are dev-authored marketing
 * content in this repo — our own pages, not user data — so which one is read is
 * safe to report and is the most useful signal the public site produces. The id
 * is still allowlisted rather than passed through (`analyticsPathForDemoEntry`).
 *
 * Needed because the demo opens an article by changing only the query string
 * (`/demo/all?entry=<id>`), which `PageViewTracker` deliberately ignores. The
 * `/demo/entry/<id>` pathname is only the internal rewrite destination.
 */
export function useTrackDemoEntryView(entryId: string | null): void {
  const reported = useRef<string | null>(null);

  useEffect(() => {
    if (!entryId || reported.current === entryId) return;
    reported.current = entryId;
    trackPageView(analyticsPathForDemoEntry(entryId));
  }, [entryId]);
}
