/**
 * EntryListItem Component
 *
 * Displays a single entry in the entry list.
 * Handles all entry types (web, email, saved) with consistent UI.
 */

"use client";

import { memo } from "react";
import { formatRelativeTime } from "@/lib/format";
import type { EntryType } from "@/lib/hooks/useEntryMutations";
import { StarIcon, StarFilledIcon } from "@/components/ui/icon-button";

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
  /** Site name for saved articles (e.g., "arXiv", "LessWrong", extracted from og:site_name) */
  siteName: string | null;
}

interface EntryListItemProps {
  entry: EntryListItemData;
  onClick?: (entryId: string) => void;
  /**
   * Callback when mousedown fires on the entry (used for prefetching).
   */
  onMouseDown?: (entryId: string) => void;
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
export function getItemClasses(read: boolean, selected: boolean): string {
  const baseClasses =
    "group relative cursor-pointer rounded-lg border p-3 transition-colors sm:p-4";

  if (selected) {
    // Selected state takes priority - accent ring indicator
    return `${baseClasses} border-accent ring-2 ring-accent ring-offset-1 dark:ring-offset-zinc-900 ${
      read ? "bg-canvas" : "bg-surface"
    }`;
  }

  if (read) {
    // Read entries recede into the page canvas: no fill of their own and a
    // faint hairline border, so they read as "already handled". They lift to a
    // surface fill on hover to signal they're still clickable.
    return `${baseClasses} border-edge bg-canvas hover:bg-surface active:bg-surface-muted dark:hover:bg-zinc-900 dark:active:bg-zinc-800`;
  }

  // Unread entries stand out as raised surface cards with a distinctly stronger
  // border (the only card/canvas separation available on e-paper, where every
  // fill is white).
  return `${baseClasses} border-zinc-300 bg-surface hover:bg-zinc-50 active:bg-zinc-100 dark:border-zinc-600 dark:hover:bg-zinc-800 dark:active:bg-zinc-700 epaper:border-zinc-500`;
}

/**
 * EntryListItem component.
 * Memoized to prevent unnecessary re-renders in virtualized lists.
 */
export const EntryListItem = memo(function EntryListItem({
  entry,
  onClick,
  onMouseDown,
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
    siteName,
    publishedAt,
    fetchedAt,
  } = entry;
  const displayTitle = title ?? "Untitled";
  // For saved articles, prefer siteName (extracted from page metadata) over feedTitle
  // feedTitle for saved articles is always "Saved Articles" (the feed name)
  const source = (type === "saved" ? siteName : null) ?? feedTitle ?? "Unknown Feed";
  const date = publishedAt ?? fetchedAt;

  const handleClick = () => {
    onClick?.(id);
  };

  const handleMouseDown = () => {
    onMouseDown?.(id);
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
      onMouseDown={handleMouseDown}
      onKeyDown={handleKeyDown}
      data-entry-id={id}
      className={getItemClasses(read, selected)}
      aria-label={`${read ? "Read" : "Unread"}${selected ? ", selected" : ""} article: ${displayTitle} from ${source}`}
    >
      <div className="flex items-start gap-3">
        {/* Read/Unread Indicator */}
        <div className="mt-1.5 shrink-0">
          {onToggleRead ? (
            // 44px WCAG touch target: pad the small dot out to 44px and cancel
            // the padding with an equal negative margin so layout is unchanged.
            <button
              type="button"
              onClick={handleToggleRead}
              className="group/toggle -m-[17px] flex items-center justify-center rounded-full p-[17px]"
              aria-label={read ? "Mark as unread" : "Mark as read"}
              title={read ? "Mark as unread" : "Mark as read"}
            >
              <span
                className={`block h-2.5 w-2.5 rounded-full transition-colors ${
                  read
                    ? "group-hover/toggle:border-accent group-hover/toggle:bg-accent-subtle border border-zinc-300 bg-transparent dark:border-zinc-600"
                    : "bg-accent-muted group-hover/toggle:bg-accent dark:bg-accent dark:group-hover/toggle:bg-accent-hover"
                }`}
              />
            </button>
          ) : (
            <span
              className={`block h-2.5 w-2.5 rounded-full ${
                read
                  ? "border border-zinc-300 bg-transparent dark:border-zinc-600"
                  : "bg-accent-muted dark:bg-accent"
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
                read ? "text-muted font-normal" : "text-strong font-semibold"
              }`}
            >
              {displayTitle}
            </h3>

            {/* Starred Indicator */}
            {onToggleStar ? (
              <button
                type="button"
                onClick={handleToggleStar}
                // 44px WCAG touch target: pad the 16px icon out to 44px and cancel
                // the padding with an equal negative margin so layout is unchanged.
                className={`-m-[14px] flex shrink-0 items-center justify-center rounded-full p-[14px] transition-colors ${
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
          <div className="ui-text-xs text-subtle mt-1 flex items-center gap-2">
            <span className="truncate">{source}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={date.toISOString()} className="shrink-0">
              {formatRelativeTime(date)}
            </time>
          </div>

          {/* Preview */}
          {summary && <p className="ui-text-sm text-muted mt-2 line-clamp-2">{summary}</p>}
        </div>
      </div>
    </article>
  );
});
