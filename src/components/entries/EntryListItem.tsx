/**
 * EntryListItem Component
 *
 * Displays a single entry in the entry list.
 * Handles all entry types (web, email, saved) with consistent UI.
 */

"use client";

import { memo } from "react";
import { formatRelativeTime } from "@/lib/format";
import { type EntryType } from "@/lib/store/realtime";
import { StarIcon, StarFilledIcon } from "@/components/ui";

/**
 * Entry data for list display (lightweight, no full content).
 */
export interface EntryListItemData {
  id: string;
  feedId: string;
  subscriptionId: string | null;
  type: EntryType;
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
   * entryType and subscriptionId are required (but subscriptionId can be null) to force explicit handling.
   */
  onToggleRead?: (
    entryId: string,
    currentlyRead: boolean,
    entryType: EntryType,
    subscriptionId: string | null
  ) => void;
  /**
   * Callback when the star indicator is clicked.
   */
  onToggleStar?: (entryId: string, currentlyStarred: boolean) => void;
}

/**
 * Get the appropriate CSS classes for the entry item based on read and selected state.
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
  const {
    id,
    title,
    summary,
    read,
    starred,
    type,
    subscriptionId,
    feedTitle,
    publishedAt,
    fetchedAt,
  } = entry;
  const displayTitle = title ?? "Untitled";
  const source = feedTitle ?? "Unknown Feed";
  const date = publishedAt ?? fetchedAt;

  const handleClick = () => {
    onClick?.(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClick?.(id);
    }
  };

  const handleToggleRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Always pass entryType and subscriptionId so page components must handle them explicitly
    onToggleRead?.(id, read, type, subscriptionId);
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
              className={`ui-text-sm line-clamp-2 ${
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
                {starred ? (
                  <StarFilledIcon className="h-4 w-4" />
                ) : (
                  <StarIcon className="h-4 w-4" />
                )}
              </button>
            ) : (
              starred && (
                <span className="shrink-0 text-amber-500 dark:text-amber-400" aria-label="Starred">
                  <StarFilledIcon className="h-4 w-4" />
                </span>
              )
            )}
          </div>

          {/* Meta Row: Source and Date */}
          <div className="ui-text-xs mt-1 flex items-center gap-2 text-zinc-500 dark:text-zinc-400">
            <span className="truncate">{source}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={date.toISOString()} className="shrink-0">
              {formatRelativeTime(date)}
            </time>
          </div>

          {/* Preview */}
          {summary && (
            <p className="ui-text-sm mt-2 line-clamp-2 text-zinc-600 dark:text-zinc-400">
              {summary}
            </p>
          )}
        </div>
      </div>
    </article>
  );
});
