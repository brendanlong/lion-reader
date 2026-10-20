/**
 * ConfirmDialog Component
 *
 * A question, a description, optional controls, and Cancel / confirm buttons.
 * Cancel (not the confirm action or an option) takes the initial focus.
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
  /** Controls below the description, e.g. an option for the action */
  options?: ReactNode;
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
  options,
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
      {options}
      <DialogFooter>
        <Button variant="secondary" onClick={onCancel} disabled={isLoading} data-autofocus>
          Cancel
        </Button>
        <Button variant={confirmVariant} onClick={onConfirm} loading={isLoading}>
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
