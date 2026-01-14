/**
 * Shared state components for article lists.
 *
 * Provides empty state, error state, and loading indicator
 * components used by EntryList for all entry types.
 */

"use client";

import { type ReactNode } from "react";

/**
 * Props for the ArticleListEmpty component.
 */
export interface ArticleListEmptyProps {
  /** Message to display */
  message: string;
  /** Optional custom icon */
  icon?: ReactNode;
}

/**
 * Default empty state icon (newspaper/document).
 */
function DefaultEmptyIcon() {
  return (
    <svg
      className="mb-4 h-12 w-12 text-zinc-400 dark:text-zinc-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 8h6v4H7V8z"
      />
    </svg>
  );
}

/**
 * Bookmark icon for saved articles empty state.
 */
export function BookmarkEmptyIcon() {
  return (
    <svg
      className="mb-4 h-12 w-12 text-zinc-400 dark:text-zinc-500"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={1.5}
        d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
      />
    </svg>
  );
}

/**
 * Empty state component for article lists.
 */
export function ArticleListEmpty({ message, icon }: ArticleListEmptyProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      {icon ?? <DefaultEmptyIcon />}
      <p className="text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
    </div>
  );
}

/**
 * Props for the ArticleListError component.
 */
export interface ArticleListErrorProps {
  /** Error message to display */
  message: string;
  /** Callback when retry button is clicked */
  onRetry: () => void;
}

/**
 * Error state component for article lists.
 */
export function ArticleListError({ message, onRetry }: ArticleListErrorProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <svg
        className="mb-4 h-12 w-12 text-red-400 dark:text-red-500"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
        />
      </svg>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">{message}</p>
      <button
        onClick={onRetry}
        className="rounded-md bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-800 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200"
      >
        Try again
      </button>
    </div>
  );
}

/**
 * Loading more indicator shown at bottom during pagination.
 */
export function ArticleListLoadingMore({ label = "Loading more..." }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-4" role="status" aria-label={label}>
      <svg
        className="h-5 w-5 animate-spin text-zinc-500"
        xmlns="http://www.w3.org/2000/svg"
        fill="none"
        viewBox="0 0 24 24"
        aria-hidden="true"
      >
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="4"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
        />
      </svg>
      <span className="sr-only">{label}</span>
    </div>
  );
}

/**
 * End of list indicator.
 */
export function ArticleListEnd({ message = "No more articles" }: { message?: string }) {
  return <p className="py-4 text-center text-sm text-zinc-400 dark:text-zinc-500">{message}</p>;
}
