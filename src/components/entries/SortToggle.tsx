/**
 * SortToggle Component
 *
 * A toggle button for switching between newest-first and oldest-first sorting.
 * Displays a sort icon that changes based on the current state.
 */

"use client";

import { type MouseEvent } from "react";

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
 * Sort descending icon (newest first) - bars from tall to short.
 */
function SortDescendingIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 4.5h14.25M3 9h9.75M3 13.5h9.75m4.5-4.5v12m0 0l-3.75-3.75M17.25 21L21 17.25"
      />
    </svg>
  );
}

/**
 * Sort ascending icon (oldest first) - bars from short to tall.
 */
function SortAscendingIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3 4.5h14.25M3 9h9.75M3 13.5h5.25m5.25-.75L17.25 9m0 0L21 12.75M17.25 9v12"
      />
    </svg>
  );
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
      <span className="ml-1.5 hidden text-sm sm:inline">
        {sortOrder === "newest" ? "Newest" : "Oldest"}
      </span>
    </button>
  );
}
