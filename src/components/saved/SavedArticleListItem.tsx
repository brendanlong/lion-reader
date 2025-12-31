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
 */
export interface SavedArticleListItemData {
  id: string;
  url: string;
  title: string | null;
  siteName: string | null;
  author: string | null;
  imageUrl: string | null;
  excerpt: string | null;
  read: boolean;
  starred: boolean;
  savedAt: Date;
}

interface SavedArticleListItemProps {
  article: SavedArticleListItemData;
  onClick?: (articleId: string) => void;
  /**
   * Whether this article is currently selected (for keyboard navigation).
   */
  selected?: boolean;
}

/**
 * SavedArticleListItem component.
 * Memoized to prevent unnecessary re-renders in virtualized lists.
 */
export const SavedArticleListItem = memo(function SavedArticleListItem({
  article,
  onClick,
  selected = false,
}: SavedArticleListItemProps) {
  return (
    <ArticleListItem
      id={article.id}
      title={article.title}
      source={article.siteName ?? getDomain(article.url)}
      date={article.savedAt}
      preview={article.excerpt}
      read={article.read}
      starred={article.starred}
      selected={selected}
      onClick={onClick}
    />
  );
});
