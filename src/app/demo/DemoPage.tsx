/**
 * DemoPage Component
 *
 * Interactive demo that looks like the real app, populated with static
 * content describing Lion Reader's features.
 */

"use client";

import { useState, useMemo, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ClientLink } from "@/components/ui";
import { LayoutShell } from "@/components/layout/LayoutShell";
import {
  ScrollContainerProvider,
  MainScrollContainer,
} from "@/components/layout/ScrollContainerContext";
import { EntryList, type ExternalQueryState } from "@/components/entries";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { TRPCProvider } from "@/lib/trpc/provider";
import { AppearanceProvider } from "@/lib/appearance";
import { DemoSidebar } from "./DemoSidebar";
import {
  DEMO_ENTRIES,
  getDemoEntriesForSubscription,
  getDemoEntriesForTag,
  getDemoEntry,
  getDemoHighlightEntries,
  getDemoSubscription,
  getDemoTag,
} from "./data";

// Static query state for the demo - no fetching, all data loaded
const STATIC_QUERY_STATE: ExternalQueryState = {
  isLoading: false,
  isError: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  fetchNextPage: () => {},
  refetch: () => {},
};

/**
 * Inner component that reads search params (must be inside Suspense).
 */
function DemoPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Redirect bare / to /?view=all&entry=welcome
  const hasParams =
    searchParams.has("view") ||
    searchParams.has("sub") ||
    searchParams.has("tag") ||
    searchParams.has("entry");
  useEffect(() => {
    if (!hasParams) {
      router.replace("/?view=all&entry=welcome");
    }
  }, [hasParams, router]);

  // Derive current state from URL search params
  const view = searchParams.get("view") ?? "all";
  const subId = searchParams.get("sub");
  const tagId = searchParams.get("tag");
  const entryId = searchParams.get("entry") ?? (!hasParams ? "welcome" : null);

  // Compute the entries to show based on current navigation
  const entries = useMemo(() => {
    if (subId) {
      return getDemoEntriesForSubscription(subId);
    }
    if (tagId) {
      return getDemoEntriesForTag(tagId);
    }
    switch (view) {
      case "highlights":
        return getDemoHighlightEntries();
      default:
        return DEMO_ENTRIES;
    }
  }, [view, subId, tagId]);

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
    switch (view) {
      case "highlights":
        return "Highlights";
      default:
        return "All Features";
    }
  }, [view, subId, tagId]);

  // Build the back-to-list href
  const backHref = subId ? `/?sub=${subId}` : tagId ? `/?tag=${tagId}` : `/?view=${view}`;

  return (
    <LayoutShell
      sidebarOpen={sidebarOpen}
      sidebarTitleHref="/?view=all"
      sidebarContent={<DemoSidebar onClose={() => setSidebarOpen(false)} />}
      sidebarOverlay={
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      }
      sidebarCloseButton={
        <button
          onClick={() => setSidebarOpen(false)}
          className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
          aria-label="Close navigation menu"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      }
      mobileMenuButton={
        <button
          onClick={() => setSidebarOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 lg:hidden dark:text-zinc-400 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
          aria-label="Open navigation menu"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          </svg>
        </button>
      }
      headerRight={
        <div className="flex items-center gap-2">
          <Link
            href="/register"
            className="ui-text-sm inline-flex min-h-[40px] items-center gap-1.5 rounded-md bg-zinc-900 px-3 font-medium text-white transition-colors hover:bg-zinc-800 active:bg-zinc-700 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:active:bg-zinc-300"
          >
            Sign Up
          </Link>
          <Link
            href="/login"
            className="ui-text-sm inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 font-medium text-zinc-700 transition-colors hover:bg-zinc-50 active:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:active:bg-zinc-700"
          >
            Sign In
          </Link>
        </div>
      }
    >
      <MainScrollContainer className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-950">
        {selectedEntry ? (
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
        ) : (
          <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
            {/* Header with title */}
            <div className="mb-4 sm:mb-6">
              <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
                {pageTitle}
              </h1>
            </div>

            {/* Entry list */}
            <EntryList
              externalEntries={entries}
              externalQueryState={STATIC_QUERY_STATE}
              onEntryClick={(id) => {
                const params = new URLSearchParams();
                if (subId) params.set("sub", subId);
                else if (tagId) params.set("tag", tagId);
                else if (view !== "all") params.set("view", view);
                params.set("entry", id);
                window.history.pushState(null, "", `/?${params.toString()}`);
                // Trigger Next.js to re-render with new params
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
              emptyMessage="No entries to display"
            />
          </div>
        )}
      </MainScrollContainer>
    </LayoutShell>
  );
}

/**
 * Demo page wrapper with required providers.
 */
export function DemoPage() {
  return (
    <TRPCProvider>
      <AppearanceProvider>
        <ScrollContainerProvider>
          <Suspense
            fallback={
              <div className="flex h-screen items-center justify-center bg-zinc-50 dark:bg-zinc-950">
                <p className="ui-text-sm text-zinc-500 dark:text-zinc-400">Loading demo...</p>
              </div>
            }
          >
            <DemoPageContent />
          </Suspense>
        </ScrollContainerProvider>
      </AppearanceProvider>
    </TRPCProvider>
  );
}
