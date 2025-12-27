/**
 * SavedArticleListItem Component
 *
 * Displays a single saved article in the list.
 * Shows title, site name, date, preview, read/unread indicator, and starred status.
 */

"use client";

import { memo } from "react";

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
 * Format a date as a relative time string (e.g., "2 hours ago").
 */
function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);
  const diffDays = Math.floor(diffHours / 24);
  const diffWeeks = Math.floor(diffDays / 7);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffSeconds < 60) {
    return "just now";
  } else if (diffMinutes < 60) {
    return `${diffMinutes} ${diffMinutes === 1 ? "minute" : "minutes"} ago`;
  } else if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? "hour" : "hours"} ago`;
  } else if (diffDays < 7) {
    return `${diffDays} ${diffDays === 1 ? "day" : "days"} ago`;
  } else if (diffWeeks < 4) {
    return `${diffWeeks} ${diffWeeks === 1 ? "week" : "weeks"} ago`;
  } else if (diffMonths < 12) {
    return `${diffMonths} ${diffMonths === 1 ? "month" : "months"} ago`;
  } else {
    return `${diffYears} ${diffYears === 1 ? "year" : "years"} ago`;
  }
}

/**
 * Extract domain from URL for display.
 */
function getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Get the appropriate CSS classes for the article item based on read and selected state.
 */
function getArticleClasses(read: boolean, selected: boolean): string {
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
 * SavedArticleListItem component.
 * Memoized to prevent unnecessary re-renders in virtualized lists.
 */
export const SavedArticleListItem = memo(function SavedArticleListItem({
  article,
  onClick,
  selected = false,
}: SavedArticleListItemProps) {
  const displayTitle = article.title ?? "Untitled";
  const displaySite = article.siteName ?? getDomain(article.url);

  const handleClick = () => {
    onClick?.(article.id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.(article.id);
    }
  };

  return (
    <article
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      data-entry-id={article.id}
      className={getArticleClasses(article.read, selected)}
      aria-label={`${article.read ? "Read" : "Unread"}${selected ? ", selected" : ""} article: ${displayTitle} from ${displaySite}`}
    >
      <div className="flex items-start gap-3">
        {/* Read/Unread Indicator */}
        <div className="mt-1.5 shrink-0">
          <span
            className={`block h-2.5 w-2.5 rounded-full ${
              article.read
                ? "border border-zinc-300 bg-transparent dark:border-zinc-600"
                : "bg-blue-500 dark:bg-blue-400"
            }`}
            aria-hidden="true"
          />
        </div>

        <div className="min-w-0 flex-1">
          {/* Title Row */}
          <div className="flex items-start justify-between gap-2">
            <h3
              className={`line-clamp-2 text-sm ${
                article.read
                  ? "font-normal text-zinc-700 dark:text-zinc-300"
                  : "font-medium text-zinc-900 dark:text-zinc-100"
              }`}
            >
              {displayTitle}
            </h3>

            {/* Starred Indicator */}
            {article.starred && (
              <span className="shrink-0 text-amber-500 dark:text-amber-400" aria-label="Starred">
                <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                </svg>
              </span>
            )}
          </div>

          {/* Meta Row: Site Name and Date */}
          <div className="mt-1 flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="truncate">{displaySite}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={article.savedAt.toISOString()} className="shrink-0">
              {formatRelativeTime(article.savedAt)}
            </time>
          </div>

          {/* Preview/Excerpt */}
          {article.excerpt && (
            <p className="mt-2 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
              {article.excerpt}
            </p>
          )}
        </div>
      </div>
    </article>
  );
});
