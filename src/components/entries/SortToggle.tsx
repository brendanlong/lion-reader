/**
 * SortToggle Component
 *
 * A toggle button for switching between newest-first and oldest-first sorting.
 * Displays a sort icon that changes based on the current state.
 */

"use client";

import { type MouseEvent } from "react";
import { SortDescendingIcon, SortAscendingIcon } from "@/components/ui";

interface SortToggleProps {
  /**
   * Current sort order: "newest" or "oldest".
   */
  sortOrder: "newest" | "oldest";

  /**
   * Callback when the toggle is clicked.
   */
  onToggle: () => void;

  /**
   * Optional class name for additional styling.
   */
  className?: string;
}

/**
 * Toggle button for switching between newest and oldest sorting.
 *
 * When `sortOrder` is "newest" (default), shows descending icon.
 * When `sortOrder` is "oldest", shows ascending icon.
 */
export function SortToggle({ sortOrder, onToggle, className = "" }: SortToggleProps) {
  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    onToggle();
  };

  const label = sortOrder === "newest" ? "Sort oldest first" : "Sort newest first";
  const Icon = sortOrder === "newest" ? SortDescendingIcon : SortAscendingIcon;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center justify-center rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:focus:ring-zinc-400 ${className}`}
      title={label}
      aria-label={label}
      aria-pressed={sortOrder === "oldest"}
    >
      <Icon className="h-5 w-5" />
      <span className="ui-text-sm ml-1.5 hidden sm:inline">
        {sortOrder === "newest" ? "Newest" : "Oldest"}
      </span>
    </button>
  );
}
