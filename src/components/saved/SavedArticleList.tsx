/**
 * SavedArticleList Component
 *
 * Displays a paginated list of saved articles with infinite scroll.
 * Supports filtering by unread only and starred only.
 */

"use client";

import { useEffect, useRef, useCallback, useMemo } from "react";
import { trpc } from "@/lib/trpc/client";
import { SavedArticleListItem, type SavedArticleListItemData } from "./SavedArticleListItem";
import { EntryListSkeleton } from "@/components/entries/EntryListSkeleton";

/**
 * Filter options for the saved article list.
 */
export interface SavedArticleListFilters {
  /**
   * Show only unread articles.
   */
  unreadOnly?: boolean;

  /**
   * Show only starred articles.
   */
  starredOnly?: boolean;
}

/**
 * Article data passed to parent for keyboard actions.
 */
export interface SavedArticleListEntryData {
  id: string;
  url: string;
  read: boolean;
  starred: boolean;
}

interface SavedArticleListProps {
  /**
   * Filter options for the list.
   */
  filters?: SavedArticleListFilters;

  /**
   * Callback when an article is clicked.
   */
  onArticleClick?: (articleId: string) => void;

  /**
   * Number of articles to fetch per page.
   * @default 20
   */
  pageSize?: number;

  /**
   * Custom empty state message.
   */
  emptyMessage?: string;

  /**
   * Currently selected article ID (for keyboard navigation highlighting).
   */
  selectedArticleId?: string | null;

  /**
   * Callback to receive article data when articles are loaded.
   * Used by parent components for keyboard navigation and actions.
   */
  onArticlesLoaded?: (articles: SavedArticleListEntryData[]) => void;
}

/**
 * Empty state component.
 */
function SavedArticleListEmpty({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg
        className="mb-4 h-12 w-12 text-zinc-400 dark:text-zinc-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
        />
      </svg>
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
    </div>
  );
}

/**
 * Error state component.
 */
function SavedArticleListError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg
        className="mb-4 h-12 w-12 text-red-400 dark:text-red-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
      <button
        onClick={onRetry}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Loading more indicator shown at bottom during pagination.
 */
function LoadingMore() {
  return (
    <div
      className="flex items-center justify-center py-4"
      role="status"
      aria-label="Loading more articles"
    >
      <svg
        className="h-5 w-5 animate-spin text-zinc-500"
        xmlns="http://www.w3.org/2000/svg"
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
      <span className="sr-only">Loading more articles...</span>
    </div>
  );
}

/**
 * SavedArticleList component with infinite scroll.
 */
export function SavedArticleList({
  filters = {},
  onArticleClick,
  pageSize = 20,
  emptyMessage = "No saved articles to display",
  selectedArticleId,
  onArticlesLoaded,
}: SavedArticleListProps) {
  const loadMoreRef = useRef<HTMLDivElement>(null);

  // Use infinite query for cursor-based pagination
  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    refetch,
  } = trpc.saved.list.useInfiniteQuery(
    {
      unreadOnly: filters.unreadOnly,
      starredOnly: filters.starredOnly,
      limit: pageSize,
    },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor,
      // Refetch when filters change
      refetchOnMount: true,
    }
  );

  // Flatten all pages into a single array of articles
  const allArticles = useMemo(() => data?.pages.flatMap((page) => page.items) ?? [], [data?.pages]);

  // Notify parent of article data for keyboard navigation and actions
  useEffect(() => {
    if (onArticlesLoaded) {
      const articles: SavedArticleListEntryData[] = allArticles.map((article) => ({
        id: article.id,
        url: article.url,
        read: article.read,
        starred: article.starred,
      }));
      onArticlesLoaded(articles);
    }
  }, [allArticles, onArticlesLoaded]);

  // Intersection Observer for infinite scroll
  const handleObserver = useCallback(
    (entries: IntersectionObserverEntry[]) => {
      const target = entries[0];
      if (target.isIntersecting && hasNextPage && !isFetchingNextPage) {
        fetchNextPage();
      }
    },
    [fetchNextPage, hasNextPage, isFetchingNextPage]
  );

  useEffect(() => {
    const observer = new IntersectionObserver(handleObserver, {
      root: null,
      rootMargin: "100px",
      threshold: 0,
    });

    const currentRef = loadMoreRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
    };
  }, [handleObserver]);

  // Initial loading state
  if (isLoading) {
    return <EntryListSkeleton count={pageSize > 10 ? 10 : pageSize} />;
  }

  // Error state
  if (isError) {
    return (
      <SavedArticleListError
        message={error?.message ?? "Failed to load articles"}
        onRetry={() => refetch()}
      />
    );
  }

  // Empty state
  if (allArticles.length === 0) {
    return <SavedArticleListEmpty message={emptyMessage} />;
  }

  return (
    <div className="space-y-3">
      {allArticles.map((article) => (
        <SavedArticleListItem
          key={article.id}
          article={article as SavedArticleListItemData}
          onClick={onArticleClick}
          selected={selectedArticleId === article.id}
        />
      ))}

      {/* Load more trigger element */}
      <div ref={loadMoreRef} className="h-1" />

      {/* Loading indicator */}
      {isFetchingNextPage && <LoadingMore />}

      {/* End of list indicator */}
      {!hasNextPage && allArticles.length > 0 && (
        <p className="py-4 text-center text-sm text-zinc-400 dark:text-zinc-500">
          No more articles
        </p>
      )}
    </div>
  );
}
