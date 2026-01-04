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
 * Fetches full content from article URL if enabled for the subscription.
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
  const hasTriggeredFullContentFetch = useRef(false);
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

  // Full content fetch mutation
  const fetchFullContentMutation = trpc.entries.fetchFullContent.useMutation({
    onSuccess: () => {
      // Refetch the entry to get the updated contentFull
      refetch();
    },
  });

  const entry = data?.entry;

  // Trigger full content fetch if enabled and not yet fetched
  useEffect(() => {
    if (
      entry &&
      entry.fetchFullContent &&
      entry.url &&
      !entry.contentFull &&
      !entry.contentFullFetchedAt && // Not yet attempted
      !hasTriggeredFullContentFetch.current &&
      !fetchFullContentMutation.isPending
    ) {
      hasTriggeredFullContentFetch.current = true;
      fetchFullContentMutation.mutate({ id: entryId });
    }
  }, [entry, entryId, fetchFullContentMutation]);

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
    // Use full content if available, otherwise fall back to cleaned content from feed
    const effectiveContentCleaned = entry.contentFull ?? entry.contentCleaned;

    // Show loading indicator if we're fetching full content
    const isLoadingFullContent =
      entry.fetchFullContent &&
      entry.url &&
      !entry.contentFull &&
      !entry.contentFullFetchedAt &&
      fetchFullContentMutation.isPending;

    content = (
      <>
        {isLoadingFullContent && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
            <svg
              className="h-4 w-4 animate-spin"
              fill="none"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span>Loading full article...</span>
          </div>
        )}
        <ArticleContentBody
          articleId={entryId}
          title={entry.title ?? "Untitled"}
          source={entry.feedTitle ?? "Unknown Feed"}
          author={entry.author}
          url={entry.url}
          date={entry.publishedAt ?? entry.fetchedAt}
          contentOriginal={entry.contentOriginal}
          contentCleaned={effectiveContentCleaned}
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
      </>
    );
  }

  // Wrap in scroll container - each entry gets its own container that starts at scroll 0
  return <div className="h-full overflow-y-auto">{content}</div>;
}
