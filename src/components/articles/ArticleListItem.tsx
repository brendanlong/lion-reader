/**
 * ArticleListItem Component
 *
 * Shared component for displaying a single article/entry in a list.
 * Used by both EntryListItem and SavedArticleListItem.
 */

"use client";

import { memo } from "react";
import { formatRelativeTime } from "@/lib/format";

/**
 * Props for the ArticleListItem component.
 */
interface ArticleListItemProps {
  /** Unique identifier for the article */
  id: string;
  /** Article title */
  title: string | null;
  /** Source name (feed title or site name) */
  source: string;
  /** Date to display (published date, fetched date, or saved date) */
  date: Date;
  /** Preview text (summary or excerpt) */
  preview: string | null;
  /** Whether the article has been read */
  read: boolean;
  /** Whether the article is starred */
  starred: boolean;
  /** Whether this article is currently selected (for keyboard navigation) */
  selected?: boolean;
  /** Callback when the article is clicked */
  onClick?: (id: string) => void;
  /** Callback when the read status indicator is clicked */
  onToggleRead?: (id: string, currentlyRead: boolean) => void;
  /** Callback when the star indicator is clicked */
  onToggleStar?: (id: string, currentlyStarred: boolean) => void;
  /** Callback to prefetch article data on mousedown (before click completes) */
  onPrefetch?: (id: string) => void;
}

/**
 * Get the appropriate CSS classes for the article item based on read and selected state.
 */
function getItemClasses(read: boolean, selected: boolean): string {
  const baseClasses =
    "group relative cursor-pointer rounded-lg border p-3 transition-colors sm:p-4";

  if (selected) {
    // Selected state takes priority - blue ring indicator
    return `${baseClasses} border-blue-500 ring-2 ring-blue-500 ring-offset-1 dark:border-blue-400 dark:ring-blue-400 dark:ring-offset-zinc-900 ${
      read ? "bg-white dark:bg-zinc-900" : "bg-zinc-50 dark:bg-zinc-800"
    }`;
  }

  if (read) {
    return `${baseClasses} border-zinc-200 bg-white hover:bg-zinc-50 active:bg-zinc-100 dark:border-zinc-800 dark:bg-zinc-900 dark:hover:bg-zinc-800/50 dark:active:bg-zinc-800`;
  }

  return `${baseClasses} border-zinc-300 bg-zinc-50 hover:bg-zinc-100 active:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700/50 dark:active:bg-zinc-700`;
}

/**
 * ArticleListItem component.
 * Memoized to prevent unnecessary re-renders in virtualized lists.
 */
export const ArticleListItem = memo(function ArticleListItem({
  id,
  title,
  source,
  date,
  preview,
  read,
  starred,
  selected = false,
  onClick,
  onToggleRead,
  onToggleStar,
  onPrefetch,
}: ArticleListItemProps) {
  const displayTitle = title ?? "Untitled";

  const handleClick = () => {
    onClick?.(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.(id);
    }
  };

  const handleMouseDown = () => {
    // Prefetch article data when user presses mouse button (before click completes)
    // This gives a 50-150ms head start with near-zero false positives
    onPrefetch?.(id);
  };

  const handleToggleRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleRead?.(id, read);
  };

  const handleToggleStar = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleStar?.(id, starred);
  };

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      data-entry-id={id}
      className={getItemClasses(read, selected)}
      aria-label={`${read ? "Read" : "Unread"}${selected ? ", selected" : ""} article: ${displayTitle} from ${source}`}
    >
      <div className="flex items-start gap-3">
        {/* Read/Unread Indicator */}
        <div className="mt-1.5 shrink-0">
          {onToggleRead ? (
            <button
              type="button"
              onClick={handleToggleRead}
              className={`block h-2.5 w-2.5 rounded-full transition-colors ${
                read
                  ? "border border-zinc-300 bg-transparent hover:border-blue-400 hover:bg-blue-100 dark:border-zinc-600 dark:hover:border-blue-400 dark:hover:bg-blue-900/50"
                  : "bg-blue-500 hover:bg-blue-600 dark:bg-blue-400 dark:hover:bg-blue-300"
              }`}
              aria-label={read ? "Mark as unread" : "Mark as read"}
              title={read ? "Mark as unread" : "Mark as read"}
            />
          ) : (
            <span
              className={`block h-2.5 w-2.5 rounded-full ${
                read
                  ? "border border-zinc-300 bg-transparent dark:border-zinc-600"
                  : "bg-blue-500 dark:bg-blue-400"
              }`}
              aria-hidden="true"
            />
          )}
        </div>

        <div className="min-w-0 flex-1">
          {/* Title Row */}
          <div className="flex items-start justify-between gap-2">
            <h3
              className={`line-clamp-2 text-sm ${
                read
                  ? "font-normal text-zinc-700 dark:text-zinc-300"
                  : "font-medium text-zinc-900 dark:text-zinc-100"
              }`}
            >
              {displayTitle}
            </h3>

            {/* Starred Indicator */}
            {onToggleStar ? (
              <button
                type="button"
                onClick={handleToggleStar}
                className={`shrink-0 transition-colors ${
                  starred
                    ? "text-amber-500 hover:text-amber-600 dark:text-amber-400 dark:hover:text-amber-300"
                    : "text-zinc-300 opacity-0 group-hover:opacity-100 hover:text-amber-400 dark:text-zinc-600 dark:hover:text-amber-400"
                }`}
                aria-label={starred ? "Remove from starred" : "Add to starred"}
                title={starred ? "Remove from starred" : "Add to starred"}
              >
                <svg
                  className="h-4 w-4"
                  fill={starred ? "currentColor" : "none"}
                  stroke="currentColor"
                  strokeWidth={starred ? 0 : 1.5}
                  viewBox="0 0 20 20"
                  aria-hidden="true"
                >
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              </button>
            ) : (
              starred && (
                <span className="shrink-0 text-amber-500 dark:text-amber-400" aria-label="Starred">
                  <svg
                    className="h-4 w-4"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                  >
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                </span>
              )
            )}
          </div>

          {/* Meta Row: Source and Date */}
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="truncate">{source}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={date.toISOString()} className="shrink-0">
              {formatRelativeTime(date)}
            </time>
          </div>

          {/* Preview */}
          {preview && (
            <p className="mt-2 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{preview}</p>
          )}
        </div>
      </div>
    </article>
  );
});
