/**
 * StateToggleButton Component
 *
 * An icon toggle button, for toggles like the unread filter and sort order.
 */

import { type MouseEvent, type ReactNode } from "react";

interface StateToggleButtonProps {
  /** Icon to display; may change with the state. */
  icon: ReactNode;

  /**
   * What the toggle turns on, as its accessible name and tooltip. It stays the
   * same in both states: `aria-pressed` carries the state, and a name that
   * flipped with it ("Show…"/"Hide…") would contradict it.
   */
  name: string;

  /** Whether the toggle is on. */
  isPressed: boolean;

  /**
   * Callback when the button is clicked. Optional so the button can render as a
   * static, inert control during SSR (e.g. the demo's crawlable list header),
   * where no handler can cross the server/client boundary.
   */
  onToggle?: () => void;

  className?: string;
}

/**
 * @example
 * ```tsx
 * <StateToggleButton
 *   icon={showUnreadOnly ? <EyeSlashIcon /> : <EyeIcon />}
 *   name="Unread only"
 *   isPressed={showUnreadOnly}
 *   onToggle={() => setShowUnreadOnly(!showUnreadOnly)}
 * />
 * ```
 */
export function StateToggleButton({
  icon,
  name,
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

  // Pressed is a fill, or on e-paper (no fills) a black edge against the
  // unpressed gray one.
  return (
    <button
      type="button"
      onClick={handleClick}
      className={`control-outline text-muted hover:bg-surface-muted hover:text-body aria-pressed:bg-surface-muted aria-pressed:text-body epaper:aria-[pressed=false]:border-fill-muted inline-flex min-h-11 min-w-11 items-center justify-center rounded-md p-2 transition-colors ${className}`}
      title={name}
      aria-label={name}
      aria-pressed={isPressed}
    >
      <span className="h-5 w-5">{icon}</span>
    </button>
  );
}
