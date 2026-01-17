/**
 * IconButton Component
 *
 * A small button for icon actions like edit, close, delete, etc.
 * Includes common icon presets for convenience.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Icon content (SVG or component) */
  icon: ReactNode;
  /** Accessible label for the button */
  "aria-label": string;
  /** Button size */
  size?: "sm" | "md";
  /** Visual variant */
  variant?: "ghost" | "subtle";
}

/**
 * Compact button for icon-only actions.
 * Always requires an aria-label for accessibility.
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
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ icon, size = "md", variant = "ghost", className = "", disabled, ...props }, ref) => {
    const sizeStyles = {
      sm: "h-7 w-7",
      md: "h-8 w-8",
    };

    const variantStyles = {
      ghost:
        "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 active:bg-zinc-200 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 dark:active:bg-zinc-700",
      subtle:
        "text-zinc-400 hover:bg-zinc-200 hover:text-zinc-600 dark:hover:bg-zinc-700 dark:hover:text-zinc-300",
    };

    return (
      <button
        ref={ref}
        type="button"
        disabled={disabled}
        className={`flex items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${sizeStyles[size]} ${variantStyles[variant]} ${className}`}
        {...props}
      >
        {icon}
      </button>
    );
  }
);

IconButton.displayName = "IconButton";

// ============================================================================
// Common Icons
// ============================================================================

interface IconProps {
  className?: string;
}

/**
 * Close/X icon
 */
export function CloseIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  );
}

/**
 * Edit/pencil icon
 */
export function EditIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
      />
    </svg>
  );
}

/**
 * Chevron down icon
 */
export function ChevronDownIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

/**
 * Chevron right icon
 */
export function ChevronRightIcon({ className = "h-4 w-4" }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
    </svg>
  );
}

/**
 * Check/checkmark icon
 */
export function CheckIcon({ className = "h-3.5 w-3.5" }: IconProps) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  );
}
