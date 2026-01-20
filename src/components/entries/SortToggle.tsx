/**
 * SortToggle Component
 *
 * A toggle button for switching between newest-first and oldest-first sorting.
 * Displays a sort icon that changes based on the current state.
 */

"use client";

import { SortDescendingIcon, SortAscendingIcon, StateToggleButton } from "@/components/ui";

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
  const label = sortOrder === "newest" ? "Newest" : "Oldest";
  const ariaLabel = sortOrder === "newest" ? "Sort oldest first" : "Sort newest first";
  const Icon = sortOrder === "newest" ? SortDescendingIcon : SortAscendingIcon;

  return (
    <StateToggleButton
      icon={<Icon className="h-5 w-5" />}
      label={label}
      ariaLabel={ariaLabel}
      isPressed={sortOrder === "oldest"}
      onToggle={onToggle}
      className={className}
    />
  );
}
