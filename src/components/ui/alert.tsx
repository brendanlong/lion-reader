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
    error: "bg-danger-subtle text-danger-subtle-foreground",
    success: "bg-success-subtle text-success-subtle-foreground",
    warning: "bg-warning-subtle text-warning-subtle-foreground",
    info: "bg-info-subtle text-info-foreground",
  };

  return (
    <div
      role="alert"
      className={`ui-text-sm rounded-md p-3 ${variantStyles[variant]} ${className}`}
    >
      {children}
    </div>
  );
}
