/**
 * EntryContent Component
 *
 * Displays the full content of a single entry.
 * Fetches entry data and delegates rendering to the shared ArticleContentBody.
 */

"use client";

import { useEffect, useRef, useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations, useShowOriginalPreference, type EntryListFilters } from "@/lib/hooks";
import { useRealtimeStore } from "@/lib/store/realtime";
import {
  ArticleContentBody,
  ArticleContentSkeleton,
  ArticleContentError,
  getDomain,
} from "@/components/articles/ArticleContentBody";

/**
 * Props for the EntryContent component.
 */
interface EntryContentProps {
  /**
   * The ID of the entry to display.
   */
  entryId: string;

  /**
   * Filters for the entry list. Used for optimistic updates when marking
   * entries as read, so they get filtered from the list immediately.
   */
  listFilters?: EntryListFilters;

  /**
   * Optional callback when the back button is clicked.
   */
  onBack?: () => void;

  /**
   * Optional callback when swiping to next entry.
   */
  onSwipeNext?: () => void;

  /**
   * Optional callback when swiping to previous entry.
   */
  onSwipePrevious?: () => void;

  /**
   * Optional ID of the next entry to prefetch.
   */
  nextEntryId?: string;

  /**
   * Optional ID of the previous entry to prefetch.
   */
  previousEntryId?: string;
}

/**
 * EntryContent component.
 *
 * Fetches and displays the full content of an entry.
 * Marks the entry as read on mount.
 */
export function EntryContent({
  entryId,
  listFilters,
  onBack,
  onSwipeNext,
  onSwipePrevious,
  nextEntryId,
  previousEntryId,
}: EntryContentProps) {
  const hasAutoMarkedRead = useRef(false);

  // Fetch the entry
  const { data, isLoading, isError, error, refetch } = trpc.entries.get.useQuery({ id: entryId });

  // Get Zustand deltas
  const readIds = useRealtimeStore((s) => s.readIds);
  const unreadIds = useRealtimeStore((s) => s.unreadIds);
  const starredIds = useRealtimeStore((s) => s.starredIds);
  const unstarredIds = useRealtimeStore((s) => s.unstarredIds);

  // Merge server data with Zustand deltas at render time
  const entry = useMemo(() => {
    if (!data?.entry) return null;

    let read = data.entry.read;
    if (readIds.has(entryId)) read = true;
    else if (unreadIds.has(entryId)) read = false;

    let starred = data.entry.starred;
    if (starredIds.has(entryId)) starred = true;
    else if (unstarredIds.has(entryId)) starred = false;

    return { ...data.entry, read, starred };
  }, [data, readIds, unreadIds, starredIds, unstarredIds, entryId]);

  // Show original preference is stored per-feed in localStorage
  const [showOriginal, setShowOriginal] = useShowOriginalPreference(entry?.feedId);

  // Prefetch next and previous entries with active observers to keep them in cache
  // These queries run in parallel and don't block the main entry fetch
  // We don't use their loading states, so they're invisible to the UI
  trpc.entries.get.useQuery({ id: nextEntryId! }, { enabled: !!nextEntryId });
  trpc.entries.get.useQuery({ id: previousEntryId! }, { enabled: !!previousEntryId });

  // Entry mutations with list filters for optimistic updates
  // When marking an entry as read, this ensures it gets filtered from the list immediately
  const { markRead, star, unstar } = useEntryMutations({ listFilters });

  // Mark entry as read once when component mounts and entry data loads
  // The ref prevents re-marking if user later toggles read status
  // Component remounts on entry change (via key={openEntryId}), resetting the ref
  useEffect(() => {
    if (hasAutoMarkedRead.current || !entry) return;
    hasAutoMarkedRead.current = true;
    if (!entry.read) {
      markRead([entryId], true);
    }
  }, [entry, entryId, markRead]);

  // Handle star toggle
  const handleStarToggle = () => {
    if (!entry) return;

    if (entry.starred) {
      unstar(entryId);
    } else {
      star(entryId);
    }
  };

  // Handle read toggle - use local mutation for consistent loading state
  const handleReadToggle = () => {
    if (!entry) return;
    markRead([entryId], !entry.read);
  };

  // Determine content based on loading/error/success state
  let content: React.ReactNode;
  if (isLoading) {
    content = <ArticleContentSkeleton />;
  } else if (isError) {
    content = (
      <ArticleContentError
        message={error?.message ?? "Failed to load entry"}
        onRetry={() => refetch()}
      />
    );
  } else if (!entry) {
    content = <ArticleContentError message="Entry not found" onRetry={() => refetch()} />;
  } else {
    content = (
      <ArticleContentBody
        articleId={entryId}
        title={entry.title ?? "Untitled"}
        source={entry.feedTitle ?? "Unknown Feed"}
        author={entry.author}
        url={entry.url}
        date={entry.publishedAt ?? entry.fetchedAt}
        contentOriginal={entry.contentOriginal}
        contentCleaned={entry.contentCleaned}
        fallbackContent={entry.summary}
        read={entry.read}
        starred={entry.starred}
        onBack={onBack}
        onToggleRead={handleReadToggle}
        onToggleStar={handleStarToggle}
        showOriginal={showOriginal}
        setShowOriginal={setShowOriginal}
        footerLinkDomain={entry.feedUrl ? getDomain(entry.feedUrl) : undefined}
        onSwipeNext={onSwipeNext}
        onSwipePrevious={onSwipePrevious}
      />
    );
  }

  // Wrap in scroll container - each entry gets its own container that starts at scroll 0
  return <div className="h-full overflow-y-auto">{content}</div>;
}
