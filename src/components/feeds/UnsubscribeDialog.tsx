/**
 * UnsubscribeDialog Component
 *
 * Confirmation dialog for unsubscribing from a feed.
 */

"use client";

import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface UnsubscribeDialogProps {
  isOpen: boolean;
  feedTitle: string;
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UnsubscribeDialog({ feedTitle, ...props }: UnsubscribeDialogProps) {
  return (
    <ConfirmDialog
      title="Unsubscribe from feed?"
      confirmLabel="Unsubscribe"
      confirmVariant="danger"
      {...props}
    >
      Are you sure you want to unsubscribe from{" "}
      <span className="text-body font-medium">{feedTitle}</span>? You can always resubscribe later.
    </ConfirmDialog>
  );
}
