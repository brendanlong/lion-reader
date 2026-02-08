/**
 * UnreadToggle Component
 *
 * A toggle button for showing/hiding read entries.
 * Displays an eye icon that changes based on the current state.
 */

"use client";

import { EyeIcon, EyeSlashIcon } from "@/components/ui/icon-button";
import { StateToggleButton } from "@/components/ui/state-toggle-button";

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
  const label = showUnreadOnly ? "Unread only" : "Show all";
  const ariaLabel = showUnreadOnly ? "Show read items" : "Hide read items";
  const Icon = showUnreadOnly ? EyeSlashIcon : EyeIcon;

  return (
    <StateToggleButton
      icon={<Icon className="h-5 w-5" />}
      label={label}
      ariaLabel={ariaLabel}
      isPressed={!showUnreadOnly}
      onToggle={onToggle}
      className={className}
    />
  );
}
