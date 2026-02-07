/**
 * DemoRouter Component
 *
 * Client-side router for the demo pages. Reads usePathname() and
 * useSearchParams() to determine which content to render, mirroring
 * the pattern used by AppRouter for the real app.
 */

"use client";

import { useMemo, useEffect, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ClientLink } from "@/components/ui";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { DemoEntryList } from "./DemoEntryList";
import {
  DEMO_ENTRIES_SORTED,
  getDemoEntriesForSubscription,
  getDemoEntriesForTag,
  getDemoEntry,
  getDemoHighlightEntries,
  getDemoSubscription,
  getDemoTag,
} from "./data";

function DemoRouterContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const entryId = searchParams.get("entry");

  // Parse the pathname to determine the current view
  const subscriptionMatch = pathname.match(/^\/demo\/subscription\/([^/]+)/);
  const tagMatch = pathname.match(/^\/demo\/tag\/([^/]+)/);
  const subId = subscriptionMatch?.[1] ?? null;
  const tagId = tagMatch?.[1] ?? null;
  const isHighlights = pathname.startsWith("/demo/highlights");

  // Compute the entries to show based on current navigation
  const entries = useMemo(() => {
    if (subId) {
      return getDemoEntriesForSubscription(subId);
    }
    if (tagId) {
      return getDemoEntriesForTag(tagId);
    }
    if (isHighlights) {
      return getDemoHighlightEntries();
    }
    return DEMO_ENTRIES_SORTED;
  }, [subId, tagId, isHighlights]);

  // Get the selected entry for detail view
  const selectedEntry = entryId ? getDemoEntry(entryId) : null;

  // Compute the page title
  const pageTitle = useMemo(() => {
    if (subId) {
      return getDemoSubscription(subId)?.title ?? "Unknown";
    }
    if (tagId) {
      return getDemoTag(tagId)?.name ?? "Unknown";
    }
    if (isHighlights) {
      return "Highlights";
    }
    return "All Features";
  }, [subId, tagId, isHighlights]);

  // Keep document.title in sync during client-side navigation
  useEffect(() => {
    const title = selectedEntry?.title ?? pageTitle;
    document.title = `${title} - Lion Reader Demo`;
  }, [selectedEntry, pageTitle]);

  // Build the back-to-list href (pathname without query params)
  const backHref = subId
    ? `/demo/subscription/${subId}`
    : tagId
      ? `/demo/tag/${tagId}`
      : isHighlights
        ? "/demo/highlights"
        : "/demo/all";

  if (selectedEntry) {
    return (
      <EntryArticle
        title={selectedEntry.title ?? "Untitled"}
        url={selectedEntry.url}
        source={selectedEntry.feedTitle ?? "Lion Reader"}
        author={selectedEntry.author}
        date={selectedEntry.publishedAt ?? selectedEntry.fetchedAt}
        contentHtml={selectedEntry.contentHtml}
        fallbackContent={selectedEntry.summary}
        backButton={
          <ClientLink
            href={backHref}
            className="ui-text-sm mb-4 -ml-2 inline-flex min-h-[44px] items-center gap-2 rounded-md px-2 text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900 active:bg-zinc-200 sm:mb-6 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 dark:active:bg-zinc-700"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 19l-7-7m0 0l7-7m-7 7h18"
              />
            </svg>
            <span>Back to list</span>
          </ClientLink>
        }
        beforeContent={
          selectedEntry.id === "welcome" ? (
            <div className="mb-6 flex flex-col items-center gap-4 rounded-lg border border-zinc-200 bg-white p-6 sm:flex-row sm:justify-center dark:border-zinc-800 dark:bg-zinc-900">
              <Link
                href="/register"
                className="ui-text-base inline-flex h-12 w-full items-center justify-center rounded-md bg-zinc-900 px-6 font-medium text-white transition-colors hover:bg-zinc-800 sm:w-auto dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
              >
                Get started
              </Link>
              <Link
                href="/login"
                className="ui-text-base inline-flex h-12 w-full items-center justify-center rounded-md border border-zinc-300 bg-white px-6 font-medium text-zinc-900 transition-colors hover:bg-zinc-50 sm:w-auto dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
              >
                Sign in
              </Link>
            </div>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      {/* Header with title */}
      <div className="mb-4 sm:mb-6">
        <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          {pageTitle}
        </h1>
      </div>

      {/* Entry list */}
      <DemoEntryList entries={entries} backHref={backHref} />
    </div>
  );
}

export function DemoRouter() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
          <div className="mb-4 sm:mb-6">
            <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
          </div>
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
            ))}
          </div>
        </div>
      }
    >
      <DemoRouterContent />
    </Suspense>
  );
}
