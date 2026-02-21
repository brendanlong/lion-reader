/**
 * Card Component
 *
 * A container component with consistent styling for sections, panels, and content areas.
 */

import type { ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  /** Padding size */
  padding?: "sm" | "md" | "lg";
  /** Additional class name */
  className?: string;
}

/**
 * Basic card container with border and background.
 *
 * @example
 * ```tsx
 * <Card>
 *   <CardHeader>
 *     <CardTitle>Settings</CardTitle>
 *   </CardHeader>
 *   <CardBody>Content here</CardBody>
 * </Card>
 * ```
 */
export function Card({ children, padding = "lg", className = "" }: CardProps) {
  const paddingStyles = {
    sm: "p-3",
    md: "p-4",
    lg: "p-6",
  };

  return (
    <div
      className={`rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 ${paddingStyles[padding]} ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Card header section.
 */
export interface CardHeaderProps {
  children: ReactNode;
  className?: string;
}

export function CardHeader({ children, className = "" }: CardHeaderProps) {
  return <div className={`mb-4 ${className}`}>{children}</div>;
}

/**
 * Card title with consistent styling.
 */
export interface CardTitleProps {
  children: ReactNode;
  className?: string;
}

export function CardTitle({ children, className = "" }: CardTitleProps) {
  return (
    <h3 className={`ui-text-base font-semibold text-zinc-900 dark:text-zinc-50 ${className}`}>
      {children}
    </h3>
  );
}

/**
 * Card description/subtitle text.
 */
export interface CardDescriptionProps {
  children: ReactNode;
  className?: string;
}

export function CardDescription({ children, className = "" }: CardDescriptionProps) {
  return (
    <p className={`ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400 ${className}`}>{children}</p>
  );
}

/**
 * Card body section for main content.
 */
export interface CardBodyProps {
  children: ReactNode;
  className?: string;
}

export function CardBody({ children, className = "" }: CardBodyProps) {
  return <div className={className}>{children}</div>;
}

/**
 * Card footer section, typically for actions.
 */
export interface CardFooterProps {
  children: ReactNode;
  className?: string;
}

export function CardFooter({ children, className = "" }: CardFooterProps) {
  return <div className={`mt-4 flex items-center justify-end gap-3 ${className}`}>{children}</div>;
}

/**
 * Colored status card for alerts, summaries, etc.
 */
export interface StatusCardProps {
  children: ReactNode;
  variant: "info" | "success" | "warning" | "error";
  padding?: "sm" | "md" | "lg";
  className?: string;
}

export function StatusCard({ children, variant, padding = "md", className = "" }: StatusCardProps) {
  const paddingStyles = {
    sm: "p-3",
    md: "p-4",
    lg: "p-6",
  };

  const variantStyles = {
    info: "border-info-border bg-info-subtle",
    success: "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20",
    warning: "border-yellow-200 bg-yellow-50 dark:border-yellow-800 dark:bg-yellow-900/20",
    error: "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20",
  };

  return (
    <div
      className={`rounded-lg border ${variantStyles[variant]} ${paddingStyles[padding]} ${className}`}
    >
      {children}
    </div>
  );
}
