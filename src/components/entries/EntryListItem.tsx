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
import type { ListDensity } from "@/lib/appearance/settings";
import { StarIcon, StarFilledIcon } from "@/components/ui/icon-button";
import { getItemClasses } from "./entryItemClasses";

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
   * Whether this entry is the current keyboard selection. Selection is shown
   * visually by the browser focus outline (the selected row is focused — see
   * `onFocus` and the j/k handlers in useKeyboardShortcuts), so this only feeds
   * the aria-label; it deliberately does not add a ring/border of its own.
   */
  selected?: boolean;
  /**
   * Callback when the entry row itself receives focus (e.g. via Tab). Used to
   * sync the keyboard-shortcut selection with browser focus so `m`/`s` act on
   * the tab-focused entry, not just one reached with j/k.
   */
  onFocus?: (entryId: string) => void;
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

  /**
   * List density. In "compact" mode the item drops its per-card border/rounding
   * and roomy padding in favor of a tighter row (the surrounding list supplies
   * `divide-edge` separators). Defaults to "comfortable".
   */
  density?: ListDensity;
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
  onFocus,
  onToggleRead,
  onToggleStar,
  density = "comfortable",
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

  const handleFocus = (e: React.FocusEvent) => {
    // Only sync selection when the row itself is focused (via Tab), not when a
    // descendant control receives focus and bubbles up (focus events bubble).
    if (e.target === e.currentTarget) {
      onFocus?.(id);
    }
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
      onFocus={handleFocus}
      data-entry-id={id}
      className={getItemClasses(read, density)}
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
              // Kept out of the tab order: tabbing a row would otherwise stop on
              // the row, then this dot, then the star. Keyboard users toggle read
              // with `m` on the focused row; this stays available to pointer users.
              tabIndex={-1}
              onClick={handleToggleRead}
              className="group/toggle -m-[17px] flex items-center justify-center rounded-full p-[17px]"
              aria-label={read ? "Mark as unread" : "Mark as read"}
              title={read ? "Mark as unread" : "Mark as read (m)"}
            >
              <span
                className={`block h-2.5 w-2.5 rounded-full transition-colors ${
                  read
                    ? "group-hover/toggle:border-edge-strong group-hover/toggle:bg-surface-muted border-edge-input border bg-transparent"
                    : "bg-body group-hover/toggle:bg-muted"
                }`}
              />
            </button>
          ) : (
            <span
              className={`block h-2.5 w-2.5 rounded-full ${
                read ? "border-edge-input border bg-transparent" : "bg-body"
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
                read ? "text-muted font-normal" : "text-body font-semibold"
              }`}
            >
              {displayTitle}
            </h3>

            {/* Starred Indicator */}
            {onToggleStar ? (
              <button
                type="button"
                // Out of the tab order like the read dot above — keyboard users
                // toggle the star with `s` on the focused row (pointer still works).
                tabIndex={-1}
                onClick={handleToggleStar}
                // 44px WCAG touch target: pad the 16px icon out to 44px and cancel
                // the padding with an equal negative margin so layout is unchanged.
                className={`-m-[14px] flex shrink-0 items-center justify-center rounded-full p-[14px] transition-colors ${
                  starred
                    ? "text-star hover:text-star-hover"
                    : "hover:text-star text-zinc-300 dark:text-zinc-600"
                }`}
                aria-label={starred ? "Remove from starred" : "Add to starred"}
                title={starred ? "Remove from starred (s)" : "Add to starred (s)"}
              >
                {starred ? (
                  <StarFilledIcon className="h-4 w-4" />
                ) : (
                  <StarIcon className="h-4 w-4" />
                )}
              </button>
            ) : (
              starred && (
                <span className="text-star shrink-0" aria-label="Starred">
                  <StarFilledIcon className="h-4 w-4" />
                </span>
              )
            )}
          </div>

          {/* Meta Row: Source and Date */}
          <div className="ui-text-xs text-muted mt-1 flex items-center gap-2">
            <span className="truncate">{source}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={date.toISOString()} className="shrink-0">
              {formatRelativeTime(date)}
            </time>
          </div>

          {/* Preview (hidden in compact density to pack more items per screen) */}
          {summary && density !== "compact" && (
            <p className="ui-text-sm text-muted mt-2 line-clamp-2">{summary}</p>
          )}
        </div>
      </div>
    </article>
  );
});
