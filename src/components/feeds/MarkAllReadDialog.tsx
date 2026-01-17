/**
 * MarkAllReadDialog Component
 *
 * Confirmation dialog for marking all entries in a feed/tag as read.
 * Uses the reusable Dialog component.
 */

"use client";

import { useEffect, useRef } from "react";
import { Dialog, DialogTitle, DialogDescription, DialogFooter, Button } from "@/components/ui";

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
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  // Focus the cancel button when dialog opens
  useEffect(() => {
    if (isOpen) {
      cancelButtonRef.current?.focus();
    }
  }, [isOpen]);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onCancel}
      title="Mark all as read"
      titleId="mark-all-read-title"
    >
      <DialogTitle id="mark-all-read-title">Mark all as read?</DialogTitle>

      <DialogDescription>
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
      </DialogDescription>

      <DialogFooter>
        <Button ref={cancelButtonRef} variant="secondary" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
        <Button variant="primary" onClick={onConfirm} loading={isLoading}>
          Mark All Read
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
