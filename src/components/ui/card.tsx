/**
 * Card Component
 *
 * A container component with consistent styling for sections, panels, and content areas.
 */

import type { ReactNode } from "react";

export interface CardProps {
  children: ReactNode;
  /** Padding size ("none" for containers whose rows carry their own padding) */
  padding?: "none" | "sm" | "md" | "lg";
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
    none: "",
    sm: "p-3",
    md: "p-4",
    lg: "p-6",
  };

  return (
    <div
      className={`border-edge bg-surface rounded-lg border ${paddingStyles[padding]} ${className}`}
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
  return <h3 className={`ui-text-base text-strong font-semibold ${className}`}>{children}</h3>;
}

/**
 * Card description/subtitle text.
 */
export interface CardDescriptionProps {
  children: ReactNode;
  className?: string;
}

export function CardDescription({ children, className = "" }: CardDescriptionProps) {
  return <p className={`ui-text-sm text-muted mt-1 ${className}`}>{children}</p>;
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
 * A subsection within a Card, separated from the content above it by a
 * top border. Use for the repeated divided-section pattern inside cards.
 */
export interface CardSectionProps {
  children: ReactNode;
  className?: string;
}

export function CardSection({ children, className = "" }: CardSectionProps) {
  return <div className={`border-edge-strong mt-6 border-t pt-6 ${className}`}>{children}</div>;
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
    success: "border-success-border bg-success-subtle",
    warning: "border-warning-border bg-warning-subtle",
    error: "border-danger-border bg-danger-subtle",
  };

  return (
    <div
      className={`rounded-lg border ${variantStyles[variant]} ${paddingStyles[padding]} ${className}`}
    >
      {children}
    </div>
  );
}
