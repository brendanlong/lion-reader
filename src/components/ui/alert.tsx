/**
 * Alert Component
 *
 * Displays messages with different severity levels.
 */

import type { ReactNode } from "react";

export interface AlertProps {
  variant?: "error" | "success" | "warning" | "info";
  children: ReactNode;
  className?: string;
}

export function Alert({ variant = "info", children, className = "" }: AlertProps) {
  const variantStyles = {
    error: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200",
    success: "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200",
    warning: "bg-yellow-50 text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200",
    info: "bg-blue-50 text-blue-800 dark:bg-blue-950 dark:text-blue-200",
  };

  return (
    <div role="alert" className={`rounded-md p-3 text-base ${variantStyles[variant]} ${className}`}>
      {children}
    </div>
  );
}
