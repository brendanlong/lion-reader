/**
 * UnreadToggle Component
 *
 * A toggle button for showing/hiding read entries.
 * Displays an eye icon that changes based on the current state.
 */

"use client";

import { type MouseEvent } from "react";
import { EyeIcon, EyeSlashIcon } from "@/components/ui";

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
 * Toggle button for showing/hiding read entries.
 *
 * The button displays the current state (like sorting buttons):
 * - When `showUnreadOnly` is true: shows "Unread only" with eye-slash icon
 * - When `showUnreadOnly` is false: shows "Show all" with open eye icon
 *
 * The aria-label describes the action (what clicking will do).
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
      aria-pressed={showUnreadOnly ? false : true}
    >
      <Icon className="h-5 w-5" />
      <span className="ui-text-sm ml-1.5 hidden sm:inline">
        {showUnreadOnly ? "Unread only" : "Show all"}
      </span>
    </button>
  );
}
