/**
 * Button Component
 *
 * A styled button with loading state and variants.
 */

import type { ButtonHTMLAttributes, Ref } from "react";
import { SpinnerIcon } from "@/components/ui/icon-button";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
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
    "inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";

  // Every variant carries a 1px border so they're all the same size. `secondary`
  // colors it in all themes; the rest use `control-outline`, which paints it
  // only on e-paper — there a button is either a black fill or a white box with
  // a black outline, and the `hover:bg-surface-muted` fills are no-ops.
  const variantStyles = {
    primary: "btn-primary control-outline",
    secondary: "border border-edge-input bg-surface text-body hover:bg-surface-muted",
    ghost: "control-outline text-body hover:bg-surface-muted",
    danger:
      "control-outline bg-danger-solid text-danger-solid-foreground hover:bg-danger-solid-hover",
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
