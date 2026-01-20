/**
 * StateToggleButton Component
 *
 * A generic toggle button that displays different icons and labels based on state.
 * Used for toggles like unread filter and sort order.
 */

import { type MouseEvent, type ReactNode } from "react";

interface StateToggleButtonProps {
  /**
   * Icon component to display.
   */
  icon: ReactNode;

  /**
   * Label text to display (hidden on small screens).
   */
  label: string;

  /**
   * Accessible label describing the action (what clicking will do).
   */
  ariaLabel: string;

  /**
   * Whether the toggle is currently pressed/active.
   */
  isPressed: boolean;

  /**
   * Callback when the button is clicked.
   */
  onToggle: () => void;

  /**
   * Optional additional class names.
   */
  className?: string;
}

/**
 * A toggle button with icon and label that changes based on state.
 *
 * @example
 * ```tsx
 * <StateToggleButton
 *   icon={showUnreadOnly ? <EyeSlashIcon /> : <EyeIcon />}
 *   label={showUnreadOnly ? "Unread only" : "Show all"}
 *   ariaLabel={showUnreadOnly ? "Show read items" : "Hide read items"}
 *   isPressed={!showUnreadOnly}
 *   onToggle={() => setShowUnreadOnly(!showUnreadOnly)}
 * />
 * ```
 */
export function StateToggleButton({
  icon,
  label,
  ariaLabel,
  isPressed,
  onToggle,
  className = "",
}: StateToggleButtonProps) {
  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    onToggle();
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`inline-flex items-center justify-center rounded-md p-2 text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-700 focus:ring-2 focus:ring-zinc-500 focus:ring-offset-2 focus:outline-none dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 dark:focus:ring-zinc-400 ${className}`}
      title={ariaLabel}
      aria-label={ariaLabel}
      aria-pressed={isPressed}
    >
      <span className="h-5 w-5">{icon}</span>
      <span className="ui-text-sm ml-1.5 hidden sm:inline">{label}</span>
    </button>
  );
}
