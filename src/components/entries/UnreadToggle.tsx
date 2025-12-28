/**
 * UnreadToggle Component
 *
 * A toggle button for showing/hiding read entries.
 * Displays an eye icon that changes based on the current state.
 */

"use client";

import { type MouseEvent } from "react";

interface UnreadToggleProps {
  /**
   * Current state: whether to show only unread items.
   */
  showUnreadOnly: boolean;

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
 * Eye icon (open) - shown when viewing all items (read items visible).
 */
function EyeIcon({ className }: { className?: string }) {
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
        d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"
      />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

/**
 * Eye slash icon - shown when hiding read items (unread only).
 */
function EyeSlashIcon({ className }: { className?: string }) {
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
        d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"
      />
    </svg>
  );
}

/**
 * Toggle button for showing/hiding read entries.
 *
 * When `showUnreadOnly` is true (default), the eye-slash icon is shown
 * to indicate read items are hidden. Clicking shows all items.
 *
 * When `showUnreadOnly` is false, the open eye icon is shown to indicate
 * all items are visible. Clicking hides read items.
 */
export function UnreadToggle({ showUnreadOnly, onToggle, className = "" }: UnreadToggleProps) {
  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    onToggle();
  };

  const label = showUnreadOnly ? "Show read items" : "Hide read items";
  const Icon = showUnreadOnly ? EyeSlashIcon : EyeIcon;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center justify-center rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:focus:ring-zinc-400 ${className}`}
      title={label}
      aria-label={label}
      aria-pressed={!showUnreadOnly}
    >
      <Icon className="h-5 w-5" />
      <span className="ml-1.5 hidden text-sm sm:inline">
        {showUnreadOnly ? "Show all" : "Unread only"}
      </span>
    </button>
  );
}
