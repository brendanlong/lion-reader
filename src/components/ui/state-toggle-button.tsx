/**
 * StateToggleButton Component
 *
 * A generic icon toggle button whose icon and tooltip reflect its state.
 * Used for toggles like unread filter and sort order.
 */

import { type MouseEvent, type ReactNode } from "react";

interface StateToggleButtonProps {
  /**
   * Icon component to display.
   */
  icon: ReactNode;

  /**
   * The control's name or current state, shown as the tooltip.
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
   * Callback when the button is clicked. Optional so the button can render as a
   * static, inert control during SSR (e.g. the demo's crawlable list header),
   * where no handler can cross the server/client boundary.
   */
  onToggle?: () => void;

  /**
   * Optional additional class names.
   */
  className?: string;
}

/**
 * An icon toggle button whose icon and tooltip change based on state.
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
  const handleClick = onToggle
    ? (e: MouseEvent) => {
        e.preventDefault();
        onToggle();
      }
    : undefined;

  return (
    <button
      type="button"
      onClick={handleClick}
      className={`control-outline text-muted hover:bg-surface-muted hover:text-body inline-flex min-h-11 min-w-11 items-center justify-center rounded-md p-2 transition-colors ${className}`}
      title={label}
      aria-label={ariaLabel}
      aria-pressed={isPressed}
    >
      <span className="h-5 w-5">{icon}</span>
    </button>
  );
}
