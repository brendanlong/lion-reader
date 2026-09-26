/**
 * ConfirmDialog Component
 *
 * A question, a description, and Cancel / confirm buttons. Cancel comes first,
 * so it (not the confirm action) takes the dialog's initial focus.
 */

"use client";

import { useId, type ReactNode } from "react";
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from "./dialog";
import { Button } from "./button";

interface ConfirmDialogProps {
  isOpen: boolean;
  /** The heading question, e.g. "Mark all as read?" */
  title: string;
  /** Description of what confirming does */
  children: ReactNode;
  confirmLabel: string;
  confirmVariant?: "primary" | "danger";
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  isOpen,
  title,
  children,
  confirmLabel,
  confirmVariant = "primary",
  isLoading,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const titleId = useId();
  return (
    <Dialog isOpen={isOpen} onClose={onCancel} title={title} titleId={titleId}>
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogDescription>{children}</DialogDescription>
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={isLoading}>
          Cancel
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={isLoading}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
