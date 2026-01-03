/**
 * EntryContent Component
 *
 * Displays the full content of a single entry.
 * Fetches entry data and delegates rendering to the shared ArticleContentBody.
 */

"use client";

import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { useEntryMutations } from "@/lib/hooks";
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
  onBack,
  onSwipeNext,
  onSwipePrevious,
  nextEntryId,
  previousEntryId,
}: EntryContentProps) {
  const hasMarkedRead = useRef(false);
  const [showOriginal, setShowOriginal] = useState(false);

  // Fetch the entry
  const { data, isLoading, isError, error, refetch } = trpc.entries.get.useQuery({ id: entryId });

  // Prefetch next and previous entries with active observers to keep them in cache
  // These queries run in parallel and don't block the main entry fetch
  // We don't use their loading states, so they're invisible to the UI
  trpc.entries.get.useQuery({ id: nextEntryId! }, { enabled: !!nextEntryId });
  trpc.entries.get.useQuery({ id: previousEntryId! }, { enabled: !!previousEntryId });

  // Entry mutations without list filters (this component operates on a single entry)
  // Note: optimistic updates happen at the list level in parent components,
  // normy automatically propagates changes to entries.get when server responds
  const { markRead, star, unstar } = useEntryMutations();

  const entry = data?.entry;

  // Mark entry as read when component mounts and entry is loaded (only once)
  useEffect(() => {
    if (entry && !hasMarkedRead.current) {
      hasMarkedRead.current = true;
      // Only mark as read if it's currently unread
      if (!entry.read) {
        markRead([entryId], true);
      }
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

  // Loading state
  if (isLoading) {
    return <ArticleContentSkeleton />;
  }

  // Error state
  if (isError) {
    return (
      <ArticleContentError
        message={error?.message ?? "Failed to load entry"}
        onRetry={() => refetch()}
      />
    );
  }

  // Entry not found
  if (!entry) {
    return <ArticleContentError message="Entry not found" onRetry={() => refetch()} />;
  }

  // Render the entry content using shared component
  return (
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
      narrationArticleType="entry"
      footerLinkDomain={entry.feedUrl ? getDomain(entry.feedUrl) : undefined}
      onSwipeNext={onSwipeNext}
      onSwipePrevious={onSwipePrevious}
    />
  );
}
