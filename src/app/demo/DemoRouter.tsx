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
import { useSwipeGesture } from "@/lib/hooks/useSwipeGesture";
import { useKeyboardShortcuts } from "@/lib/hooks/useKeyboardShortcuts";
import { clientPush, extractParamsFromPathname } from "@/lib/navigation";
import { DemoArticleView } from "./DemoArticleView";
import { DemoEntryList } from "./DemoEntryList";
import { DemoListHeader } from "./DemoListHeader";
import { DemoListSkeleton } from "./DemoListSkeleton";
import { useDemoState } from "./DemoStateContext";
import {
  DEMO_ENTRIES,
  getDemoEntriesForSubscription,
  getDemoEntriesForTag,
  getDemoEntry,
  getDemoSubscription,
  getDemoTag,
} from "./data";

function DemoRouterContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const entryId = searchParams.get("entry");
  const demoState = useDemoState();

  // Parse the pathname to determine the current view
  const { subscriptionId: subId, tagId } = extractParamsFromPathname(pathname, "/demo");
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
    document.title = `${title} - Lion Reader`;
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
  const { selectedEntryId, setSelectedEntryId } = useKeyboardShortcuts({
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

  // Sync selection with browser focus so Tabbing to a row makes m/s act on it,
  // matching the real app.
  const handleEntryFocus = useCallback(
    (id: string) => {
      setSelectedEntryId(id);
    },
    [setSelectedEntryId]
  );

  const { onTouchStart: handleTouchStart, onTouchEnd: handleTouchEnd } = useSwipeGesture({
    onSwipeLeft: nextEntryId ? () => openEntry(nextEntryId) : undefined,
    onSwipeRight: previousEntryId ? () => openEntry(previousEntryId) : undefined,
    enabled: Boolean(entryId),
  });

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
      <DemoArticleView
        key={selectedEntry.id}
        entry={selectedEntry}
        backHref={backHref}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      />
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      {/* Header with title and action buttons — same component (and markup) the
          SSR list renders, so the swap on hydration is seamless. */}
      <DemoListHeader
        title={pageTitle}
        showActions={!isHighlights}
        sortOrder={demoState.sortOrder}
        showUnreadOnly={demoState.showUnreadOnly}
        markAllReadDescription={markAllReadDescription}
        onMarkAllRead={() => {
          // Mark all currently-visible base entries as read
          const ids = baseEntries.map((e) => e.id);
          demoState.markAllRead(ids);
        }}
        onToggleSort={demoState.toggleSortOrder}
        onToggleUnread={demoState.toggleShowUnreadOnly}
      />

      {/* Entry list */}
      <DemoEntryList
        entries={entries}
        backHref={backHref}
        selectedEntryId={selectedEntryId}
        onEntryFocus={handleEntryFocus}
      />
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
