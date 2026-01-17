/**
 * Button Component
 *
 * A styled button with loading state and variants.
 */

import { forwardRef, type ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      loading = false,
      disabled,
      className = "",
      children,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      "inline-flex items-center justify-center rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50";

    const variantStyles = {
      primary:
        "bg-zinc-900 text-white hover:bg-zinc-800 focus:ring-zinc-900 dark:bg-zinc-50 dark:text-zinc-900 dark:hover:bg-zinc-200 dark:focus:ring-zinc-400",
      secondary:
        "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50 focus:ring-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-400",
      ghost:
        "text-zinc-900 hover:bg-zinc-100 focus:ring-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800 dark:focus:ring-zinc-400",
    };

    // Ensure minimum 44px height for touch targets on mobile (WCAG touch target guidelines)
    const sizeStyles = {
      sm: "min-h-[36px] px-3 ui-text-base sm:min-h-[32px]",
      md: "min-h-[44px] px-4 ui-text-base",
      lg: "min-h-[48px] px-6 ui-text-lg",
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
        {...props}
      >
        {loading && (
          <svg
            className="mr-2 -ml-1 h-4 w-4 animate-spin"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = "Button";
