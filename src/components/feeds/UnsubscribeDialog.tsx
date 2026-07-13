/**
 * UnsubscribeDialog Component
 *
 * Confirmation dialog for unsubscribing from a feed.
 * Uses the reusable Dialog component.
 */

"use client";

import { useEffect, useRef } from "react";
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

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
      title="Unsubscribe from feed"
      titleId="unsubscribe-title"
    >
      <DialogTitle id="unsubscribe-title">Unsubscribe from feed?</DialogTitle>

      <DialogDescription>
        Are you sure you want to unsubscribe from{" "}
        <span className="text-strong font-medium">{feedTitle}</span>? You can always resubscribe
        later.
      </DialogDescription>

      <DialogFooter>
        <Button ref={cancelButtonRef} variant="secondary" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} loading={isLoading}>
          Unsubscribe
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
