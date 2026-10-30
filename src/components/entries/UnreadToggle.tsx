/**
 * UnreadToggle Component
 *
 * A toggle button for showing/hiding read entries.
 * Displays an eye icon that changes based on the current state.
 */

"use client";

import { EyeIcon, EyeSlashIcon } from "@/components/ui/icons";
import { StateToggleButton } from "@/components/ui/state-toggle-button";

interface UnreadToggleProps {
  /**
   * Current state: whether to show only unread items.
   */
  showUnreadOnly: boolean;

  /**
   * Callback when the toggle is clicked. Optional so it can render inert during
   * SSR (see StateToggleButton).
   */
  onToggle?: () => void;

  /**
   * Optional class name for additional styling.
   */
  className?: string;
}

export function UnreadToggle({ showUnreadOnly, onToggle, className = "" }: UnreadToggleProps) {
  const Icon = showUnreadOnly ? EyeSlashIcon : EyeIcon;

  return (
    <StateToggleButton
      icon={<Icon className="h-5 w-5" />}
      name="Unread only"
      isPressed={showUnreadOnly}
      onToggle={onToggle}
      className={className}
    />
  );
}
