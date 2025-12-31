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
  feedTitle: string | null; // Used as source name
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
}: SavedArticleListItemProps) {
  return (
    <ArticleListItem
      id={article.id}
      title={article.title}
      source={article.feedTitle ?? getDomain(article.url ?? "")}
      date={article.fetchedAt}
      preview={article.summary}
      read={article.read}
      starred={article.starred}
      selected={selected}
      onClick={onClick}
      onToggleRead={onToggleRead}
      onToggleStar={onToggleStar}
    />
  );
});
