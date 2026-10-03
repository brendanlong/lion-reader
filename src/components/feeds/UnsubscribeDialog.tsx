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
  /** Collections are deleted rather than unsubscribed from; their articles stay put. */
  isCollection?: boolean;
  isLoading: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function UnsubscribeDialog({ feedTitle, isCollection, ...props }: UnsubscribeDialogProps) {
  if (isCollection) {
    return (
      <ConfirmDialog
        title="Delete collection?"
        confirmLabel="Delete"
        confirmVariant="danger"
        {...props}
      >
        Delete <span className="text-body font-medium">{feedTitle}</span>? Its articles stay in
        their feeds and in Saved. Ones from feeds you&apos;ve unsubscribed from disappear unless
        they&apos;re starred.
      </ConfirmDialog>
    );
  }
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
