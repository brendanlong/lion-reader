/**
 * DemoRouter Component
 *
 * Client-side router for the demo pages. Reads usePathname() and
 * useSearchParams() to determine which content to render, mirroring
 * the pattern used by AppRouter for the real app.
 *
 * Integrates with DemoStateContext for interactive read/starred state,
 * sort order, unread-only filtering, and mark-all-read functionality.
 */

"use client";

import { useMemo, useEffect, useCallback, useRef, Suspense } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ClientLink,
  Button,
  StarIcon,
  StarFilledIcon,
  CircleIcon,
  CircleFilledIcon,
} from "@/components/ui";
import { EntryArticle } from "@/components/entries/EntryArticle";
import { SWIPE_CONFIG } from "@/components/entries/EntryContentHelpers";
import { SortToggle } from "@/components/entries/SortToggle";
import { UnreadToggle } from "@/components/entries/UnreadToggle";
import { MarkAllReadButton } from "@/components/entries/MarkAllReadButton";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { clientPush } from "@/lib/navigation";
import { DemoEntryList } from "./DemoEntryList";
import { DemoListSkeleton } from "./DemoListSkeleton";
import { useDemoState } from "./DemoStateContext";
import {
  DEMO_ENTRIES,
  getDemoEntriesForSubscription,
  getDemoEntriesForTag,
  getDemoEntry,
  getDemoEntryArticleProps,
  getDemoSubscription,
  getDemoTag,
} from "./data";

function DemoRouterContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const entryId = searchParams.get("entry");
  const demoState = useDemoState();

  // Parse the pathname to determine the current view
  const subscriptionMatch = pathname.match(/^\/demo\/subscription\/([^/]+)/);
  const tagMatch = pathname.match(/^\/demo\/tag\/([^/]+)/);
  const subId = subscriptionMatch?.[1] ?? null;
  const tagId = tagMatch?.[1] ?? null;
  const isHighlights = pathname.startsWith("/demo/highlights");

  // Compute the base entries (before state overrides) based on current navigation
  const baseEntries = useMemo(() => {
    if (subId) {
      return getDemoEntriesForSubscription(subId);
    }
    if (tagId) {
      return getDemoEntriesForTag(tagId);
    }
    if (isHighlights) {
      // Highlights uses live starred state from context
      return demoState.getStarredEntries();
    }
    return [...DEMO_ENTRIES];
  }, [subId, tagId, isHighlights, demoState]);

  // Apply state overrides (read/starred, sort, unread filter)
  // For highlights, skip unread filter and just apply sort/state
  const entries = useMemo(() => {
    if (isHighlights) {
      // For highlights, entries are already filtered to starred only
      // Just sort them
      return [...baseEntries].sort((a, b) => {
        const timeA = a.publishedAt?.getTime() ?? 0;
        const timeB = b.publishedAt?.getTime() ?? 0;
        return demoState.sortOrder === "newest" ? timeB - timeA : timeA - timeB;
      });
    }
    return demoState.applyState(baseEntries);
  }, [baseEntries, isHighlights, demoState]);

  // Get the selected entry for detail view (with live state)
  const selectedEntry = useMemo(() => {
    if (!entryId) return null;
    const entry = getDemoEntry(entryId);
    if (!entry) return null;
    const state = demoState.getEntryState(entryId);
    return { ...entry, read: state.read, starred: state.starred };
  }, [entryId, demoState]);

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

  // Context description for mark-all-read dialog
  const markAllReadDescription = useMemo(() => {
    if (subId) {
      return getDemoSubscription(subId)?.title ?? "this subscription";
    }
    if (tagId) {
      return getDemoTag(tagId)?.name ?? "this tag";
    }
    return "all features";
  }, [subId, tagId]);

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

  // Compute next/previous entry IDs for keyboard/swipe navigation
  const { nextEntryId, previousEntryId } = useMemo(() => {
    if (!entryId || entries.length === 0) {
      return { nextEntryId: undefined, previousEntryId: undefined };
    }
    const currentIndex = entries.findIndex((e) => e.id === entryId);
    if (currentIndex === -1) {
      return { nextEntryId: undefined, previousEntryId: undefined };
    }
    return {
      nextEntryId: currentIndex < entries.length - 1 ? entries[currentIndex + 1].id : undefined,
      previousEntryId: currentIndex > 0 ? entries[currentIndex - 1].id : undefined,
    };
  }, [entryId, entries]);

  // Navigation callbacks for keyboard shortcuts and swipe gestures
  const openEntry = useCallback(
    (id: string) => {
      clientPush(`${backHref}?entry=${id}`);
    },
    [backHref]
  );

  const closeEntry = useCallback(() => {
    clientPush(backHref);
  }, [backHref]);

  const goToNextEntry = useCallback(() => {
    if (nextEntryId) {
      openEntry(nextEntryId);
    }
  }, [nextEntryId, openEntry]);

  const goToPreviousEntry = useCallback(() => {
    if (previousEntryId) {
      openEntry(previousEntryId);
    }
  }, [previousEntryId, openEntry]);

  // Toggle handlers for keyboard shortcuts
  const handleToggleRead = useCallback(
    (id: string) => {
      demoState.toggleRead(id);
    },
    [demoState]
  );

  const handleToggleStar = useCallback(
    (id: string) => {
      demoState.toggleStar(id);
    },
    [demoState]
  );

  // Keyboard shortcuts (j/k navigation, o/Enter to open, Escape to close, etc.)
  const { selectedEntryId } = useKeyboardShortcuts({
    entries,
    onOpenEntry: openEntry,
    onClose: closeEntry,
    isEntryOpen: !!entryId,
    openEntryId: entryId,
    enabled: true,
    onToggleRead: handleToggleRead,
    onToggleStar: handleToggleStar,
    onToggleUnreadOnly: isHighlights ? undefined : demoState.toggleShowUnreadOnly,
    onNavigateNext: goToNextEntry,
    onNavigatePrevious: goToPreviousEntry,
  });

  // Swipe gesture handlers for entry detail view
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (!entryId) return;
      const touch = e.touches[0];
      touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    },
    [entryId]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (!touchStartRef.current) return;

      const touch = e.changedTouches[0];
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;
      touchStartRef.current = null;

      if (Math.abs(deltaY) > SWIPE_CONFIG.MAX_VERTICAL_DISTANCE) return;
      if (Math.abs(deltaX) < SWIPE_CONFIG.SWIPE_THRESHOLD) return;

      if (deltaX < 0 && nextEntryId) {
        openEntry(nextEntryId);
      } else if (deltaX > 0 && previousEntryId) {
        openEntry(previousEntryId);
      }
    },
    [nextEntryId, previousEntryId, openEntry]
  );

  // Auto-mark entry as read when viewing it (like the real app)
  const hasSentMarkRead = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedEntry) return;
    if (hasSentMarkRead.current === selectedEntry.id) return;
    hasSentMarkRead.current = selectedEntry.id;
    if (!selectedEntry.read) {
      demoState.markRead(selectedEntry.id, true);
    }
  }, [selectedEntry, demoState]);

  if (selectedEntry) {
    return (
      <EntryArticle
        {...getDemoEntryArticleProps(selectedEntry)}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
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
        actionButtons={
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            {/* Star button */}
            <Button
              variant={selectedEntry.starred ? "primary" : "secondary"}
              size="sm"
              onClick={() => demoState.toggleStar(selectedEntry.id)}
              className={
                selectedEntry.starred
                  ? "bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-500 dark:text-white dark:hover:bg-amber-600"
                  : ""
              }
              aria-label={selectedEntry.starred ? "Remove from starred" : "Add to starred"}
            >
              {selectedEntry.starred ? (
                <StarFilledIcon className="h-5 w-5" />
              ) : (
                <StarIcon className="h-5 w-5" />
              )}
              <span className="ml-2">{selectedEntry.starred ? "Starred" : "Star"}</span>
            </Button>

            {/* Mark read/unread button */}
            <Button
              variant={!selectedEntry.read ? "primary" : "secondary"}
              size="sm"
              onClick={() => demoState.toggleRead(selectedEntry.id)}
              aria-label={selectedEntry.read ? "Mark as unread" : "Mark as read"}
            >
              {selectedEntry.read ? (
                <CircleIcon className="h-4 w-4" />
              ) : (
                <CircleFilledIcon className="h-4 w-4" />
              )}
              <span className="ml-2">{selectedEntry.read ? "Read" : "Unread"}</span>
            </Button>
          </div>
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
      {/* Header with title and action buttons */}
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <h1 className="ui-text-xl sm:ui-text-2xl font-bold text-zinc-900 dark:text-zinc-50">
          {pageTitle}
        </h1>
        {!isHighlights && (
          <div className="flex gap-2">
            <MarkAllReadButton
              contextDescription={markAllReadDescription}
              isLoading={false}
              onConfirm={() => {
                // Mark all currently-visible base entries as read
                const ids = baseEntries.map((e) => e.id);
                demoState.markAllRead(ids);
              }}
            />
            <SortToggle sortOrder={demoState.sortOrder} onToggle={demoState.toggleSortOrder} />
            <UnreadToggle
              showUnreadOnly={demoState.showUnreadOnly}
              onToggle={demoState.toggleShowUnreadOnly}
            />
          </div>
        )}
      </div>

      {/* Entry list */}
      <DemoEntryList entries={entries} backHref={backHref} selectedEntryId={selectedEntryId} />
    </div>
  );
}

export function DemoRouter() {
  return (
    <Suspense fallback={<DemoListSkeleton />}>
      <DemoRouterContent />
    </Suspense>
  );
}
