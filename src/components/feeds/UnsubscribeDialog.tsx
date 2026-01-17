/**
 * UnsubscribeDialog Component
 *
 * Confirmation dialog for unsubscribing from a feed.
 * Uses a portal to render on top of other content.
 */

"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";

interface UnsubscribeDialogProps {
  isOpen: boolean;
  feedTitle: string;
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UnsubscribeDialog({
  isOpen,
  feedTitle,
  isLoading,
  onConfirm,
  onCancel,
}: UnsubscribeDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // Focus trap and escape key handling
  useEffect(() => {
    if (!isOpen) return;

    // Focus the cancel button when dialog opens
    cancelButtonRef.current?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onCancel]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="unsubscribe-title"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} aria-hidden="true" />

      {/* Dialog */}
      <div
        ref={dialogRef}
        className="relative z-10 mx-4 w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      >
        <h2
          id="unsubscribe-title"
          className="text-xl font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Unsubscribe from feed?
        </h2>

        <p className="mt-2 text-base text-zinc-600 dark:text-zinc-400">
          Are you sure you want to unsubscribe from{" "}
          <span className="font-medium text-zinc-900 dark:text-zinc-50">{feedTitle}</span>? You can
          always resubscribe later.
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancelButtonRef} variant="secondary" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            loading={isLoading}
            className="bg-red-600 hover:bg-red-700 focus:ring-red-600 dark:bg-red-600 dark:hover:bg-red-700 dark:focus:ring-red-600"
          >
            Unsubscribe
          </Button>
        </div>
      </div>
    </div>
  );
}
