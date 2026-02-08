/**
 * Button Component
 *
 * A styled button with loading state and variants.
 */

import type { ButtonHTMLAttributes, Ref } from "react";
import { SpinnerIcon } from "@/components/ui/icon-button";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  disabled,
  className = "",
  children,
  ref,
  ...props
}: ButtonProps) {
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
    sm: "min-h-[36px] px-3 ui-text-sm sm:min-h-[32px]",
    md: "min-h-[44px] px-4 ui-text-sm",
    lg: "min-h-[48px] px-6 ui-text-base",
  };

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`${baseStyles} ${variantStyles[variant]} ${sizeStyles[size]} ${className}`}
      {...props}
    >
      {loading && <SpinnerIcon className="mr-2 -ml-1 h-4 w-4" />}
      {children}
    </button>
  );
}
