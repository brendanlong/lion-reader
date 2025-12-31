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
import {
  ArticleListEmpty,
  ArticleListError,
  ArticleListLoadingMore,
  ArticleListEnd,
  BookmarkEmptyIcon,
} from "@/components/articles/ArticleListStates";

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

  /**
   * Sort order: "newest" (default) or "oldest".
   */
  sortOrder?: "newest" | "oldest";
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
      sortOrder: filters.sortOrder,
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
      <ArticleListError
        message={error?.message ?? "Failed to load articles"}
        onRetry={() => refetch()}
      />
    );
  }

  // Empty state
  if (allArticles.length === 0) {
    return <ArticleListEmpty message={emptyMessage} icon={<BookmarkEmptyIcon />} />;
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
      {isFetchingNextPage && <ArticleListLoadingMore label="Loading more articles..." />}

      {/* End of list indicator */}
      {!hasNextPage && allArticles.length > 0 && <ArticleListEnd message="No more articles" />}
    </div>
  );
}
