/**
 * IconButton Component
 *
 * A small button for icon actions like edit, close, delete, etc. Pair it with an
 * icon from `@/components/ui/icons`.
 */

import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon content (SVG or component) */
  icon: ReactNode;
  /** Accessible label for the button */
  "aria-label": string;
  /**
   * `md` is a 44px touch target on hover-less devices. `sm` stays 28px
   * everywhere, for dense rows that stretch its hit area themselves (see
   * SubscriptionItem).
   */
  size?: "sm" | "md";
  /** Visual variant */
  variant?: "ghost" | "subtle";
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Compact button for icon-only actions.
 * Always requires an aria-label for accessibility.
 *
 * Both variants are borderless everywhere except e-paper, where `control-outline`
 * gives them the same black box as every other control (see globals.css).
 *
 * @example
 * ```tsx
 * <IconButton
 *   icon={<CloseIcon />}
 *   aria-label="Close dialog"
 *   onClick={onClose}
 * />
 * ```
 */
export function IconButton({
  icon,
  size = "md",
  variant = "ghost",
  className = "",
  disabled,
  ref,
  ...props
}: IconButtonProps) {
  const sizeStyles = {
    sm: "h-7 w-7",
    md: "h-8 w-8 hover-none:h-11 hover-none:w-11",
  };

  const variantStyles = {
    ghost: "text-muted hover:bg-surface-muted hover:text-body active:bg-surface-pressed",
    subtle: "text-faint hover:bg-fill-muted hover:text-muted",
  };

  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      className={`control-outline flex items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
      {...props}
    >
      {icon}
    </button>
  );
}
