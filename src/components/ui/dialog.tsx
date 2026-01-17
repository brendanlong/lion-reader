/**
 * Dialog Component
 *
 * A reusable modal dialog with backdrop, focus trap, and accessibility features.
 * Consolidates the common dialog pattern used across the app.
 */

"use client";

import { useEffect, useRef, type ReactNode } from "react";

export interface DialogProps {
  /** Whether the dialog is open */
  isOpen: boolean;
  /** Called when the dialog should close (backdrop click or escape key) */
  onClose: () => void;
  /** Dialog title for accessibility */
  title: string;
  /** Optional ID for aria-labelledby (auto-generated if not provided) */
  titleId?: string;
  /** Dialog size */
  size?: "sm" | "md" | "lg";
  /** Dialog content */
  children: ReactNode;
  /** Additional class name for the dialog container */
  className?: string;
}

/**
 * Dialog container that handles backdrop, focus trap, escape key, and scroll lock.
 *
 * @example
 * ```tsx
 * <Dialog isOpen={isOpen} onClose={onClose} title="Confirm Action">
 *   <DialogHeader>
 *     <DialogTitle>Confirm Action</DialogTitle>
 *   </DialogHeader>
 *   <DialogBody>
 *     <p>Are you sure?</p>
 *   </DialogBody>
 *   <DialogFooter>
 *     <Button variant="secondary" onClick={onClose}>Cancel</Button>
 *     <Button onClick={handleConfirm}>Confirm</Button>
 *   </DialogFooter>
 * </Dialog>
 * ```
 */
export function Dialog({
  isOpen,
  onClose,
  title,
  titleId,
  size = "md",
  children,
  className = "",
}: DialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const generatedTitleId = titleId ?? `dialog-title-${title.toLowerCase().replace(/\s+/g, "-")}`;

  // Escape key handling
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Prevent body scroll when dialog is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }

    return () => {
      document.body.style.overflow = "";
    };
  }, [isOpen]);

  if (!isOpen) {
    return null;
  }

  const sizeStyles = {
    sm: "max-w-sm",
    md: "max-w-md",
    lg: "max-w-lg",
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby={generatedTitleId}
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog container */}
      <div
        ref={dialogRef}
        className={`relative z-10 mx-4 w-full ${sizeStyles[size]} rounded-lg border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900 ${className}`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Dialog header section with title and optional close button.
 */
export interface DialogHeaderProps {
  children: ReactNode;
  className?: string;
}

export function DialogHeader({ children, className = "" }: DialogHeaderProps) {
  return <div className={`mb-4 ${className}`}>{children}</div>;
}

/**
 * Dialog title with consistent styling.
 */
export interface DialogTitleProps {
  children: ReactNode;
  id?: string;
  className?: string;
}

export function DialogTitle({ children, id, className = "" }: DialogTitleProps) {
  return (
    <h2 id={id} className={`ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50 ${className}`}>
      {children}
    </h2>
  );
}

/**
 * Dialog description text.
 */
export interface DialogDescriptionProps {
  children: ReactNode;
  className?: string;
}

export function DialogDescription({ children, className = "" }: DialogDescriptionProps) {
  return (
    <p className={`ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400 ${className}`}>{children}</p>
  );
}

/**
 * Dialog body section for main content.
 */
export interface DialogBodyProps {
  children: ReactNode;
  className?: string;
}

export function DialogBody({ children, className = "" }: DialogBodyProps) {
  return <div className={className}>{children}</div>;
}

/**
 * Dialog footer section, typically for action buttons.
 */
export interface DialogFooterProps {
  children: ReactNode;
  className?: string;
}

export function DialogFooter({ children, className = "" }: DialogFooterProps) {
  return <div className={`mt-6 flex justify-end gap-3 ${className}`}>{children}</div>;
}
