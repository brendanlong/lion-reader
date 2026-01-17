/**
 * MarkAllReadDialog Component
 *
 * Confirmation dialog for marking all entries in a feed/tag as read.
 * Uses a portal to render on top of other content.
 */

"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui";

interface MarkAllReadDialogProps {
  isOpen: boolean;
  /** Description of what will be marked as read (e.g., "this feed", "all items", "this tag") */
  contextDescription: string;
  /** Number of unread entries that will be marked as read */
  unreadCount?: number;
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function MarkAllReadDialog({
  isOpen,
  contextDescription,
  unreadCount,
  isLoading,
  onConfirm,
  onCancel,
}: MarkAllReadDialogProps) {
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
      aria-labelledby="mark-all-read-title"
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} aria-hidden="true" />

      {/* Dialog */}
      <div
        ref={dialogRef}
        className="relative z-10 mx-4 w-full max-w-md rounded-lg border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
      >
        <h2
          id="mark-all-read-title"
          className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50"
        >
          Mark all as read?
        </h2>

        <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
          {unreadCount !== undefined && unreadCount > 0 ? (
            <>
              This will mark{" "}
              <span className="font-medium text-zinc-900 dark:text-zinc-50">
                {unreadCount} {unreadCount === 1 ? "entry" : "entries"}
              </span>{" "}
              in {contextDescription} as read.
            </>
          ) : (
            <>This will mark all unread entries in {contextDescription} as read.</>
          )}
        </p>

        <div className="mt-6 flex justify-end gap-3">
          <Button ref={cancelButtonRef} variant="secondary" onClick={onCancel} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} loading={isLoading}>
            Mark All Read
          </Button>
        </div>
      </div>
    </div>
  );
}
