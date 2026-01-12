/**
 * EntryListItem Component
 *
 * Displays a single entry in the entry list.
 * Thin wrapper around ArticleListItem that maps entry-specific data.
 */

"use client";

import { memo } from "react";
import { ArticleListItem } from "@/components/articles/ArticleListItem";

/**
 * Entry data for list display (lightweight, no full content).
 */
interface EntryListItemData {
  id: string;
  feedId: string;
  url: string | null;
  title: string | null;
  author: string | null;
  summary: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  read: boolean;
  starred: boolean;
  feedTitle: string | null;
}

interface EntryListItemProps {
  entry: EntryListItemData;
  onClick?: (entryId: string) => void;
  /**
   * Whether this entry is currently selected (for keyboard navigation).
   */
  selected?: boolean;
  /**
   * Callback when the read status indicator is clicked.
   */
  onToggleRead?: (entryId: string, currentlyRead: boolean) => void;
  /**
   * Callback when the star indicator is clicked.
   */
  onToggleStar?: (entryId: string, currentlyStarred: boolean) => void;
}

/**
 * EntryListItem component.
 * Memoized to prevent unnecessary re-renders in virtualized lists.
 */
export const EntryListItem = memo(function EntryListItem({
  entry,
  onClick,
  selected = false,
  onToggleRead,
  onToggleStar,
}: EntryListItemProps) {
  return (
    <ArticleListItem
      id={entry.id}
      title={entry.title}
      source={entry.feedTitle ?? "Unknown Feed"}
      date={entry.publishedAt ?? entry.fetchedAt}
      preview={entry.summary}
      read={entry.read}
      starred={entry.starred}
      selected={selected}
      onClick={onClick}
      onToggleRead={onToggleRead}
      onToggleStar={onToggleStar}
    />
  );
});
