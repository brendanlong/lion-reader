/**
 * SavedArticleListItem Component
 *
 * Displays a single saved article in the list.
 * Thin wrapper around ArticleListItem that maps saved article-specific data.
 */

"use client";

import { memo } from "react";
import { ArticleListItem } from "@/components/articles/ArticleListItem";
import { getDomain } from "@/lib/format";

/**
 * Saved article data for list display (lightweight, no full content).
 * Maps to the unified entries endpoint response.
 */
export interface SavedArticleListItemData {
  id: string;
  url: string | null;
  title: string | null;
  feedTitle: string | null;
  siteName: string | null; // Website name from og:site_name, used as source
  author: string | null;
  summary: string | null; // Excerpt
  read: boolean;
  starred: boolean;
  fetchedAt: Date; // Used as savedAt
}

interface SavedArticleListItemProps {
  article: SavedArticleListItemData;
  onClick?: (articleId: string) => void;
  /**
   * Whether this article is currently selected (for keyboard navigation).
   */
  selected?: boolean;
  /**
   * Callback when the read status indicator is clicked.
   */
  onToggleRead?: (articleId: string, currentlyRead: boolean) => void;
  /**
   * Callback when the star indicator is clicked.
   */
  onToggleStar?: (articleId: string, currentlyStarred: boolean) => void;
  /**
   * Callback to prefetch article data on mousedown (before click completes).
   */
  onPrefetch?: (articleId: string) => void;
}

/**
 * SavedArticleListItem component.
 * Memoized to prevent unnecessary re-renders in virtualized lists.
 */
export const SavedArticleListItem = memo(function SavedArticleListItem({
  article,
  onClick,
  selected = false,
  onToggleRead,
  onToggleStar,
  onPrefetch,
}: SavedArticleListItemProps) {
  // For saved articles, prefer siteName (from og:site_name) over feedTitle (which is "Saved Articles")
  const source = article.siteName ?? getDomain(article.url ?? "");
  return (
    <ArticleListItem
      id={article.id}
      title={article.title}
      source={source}
      date={article.fetchedAt}
      preview={article.summary}
      read={article.read}
      starred={article.starred}
      selected={selected}
      onClick={onClick}
      onToggleRead={onToggleRead}
      onToggleStar={onToggleStar}
      onPrefetch={onPrefetch}
    />
  );
});
