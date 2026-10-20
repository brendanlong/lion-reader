/**
 * UnsubscribeDialog Component
 *
 * Confirmation dialog for unsubscribing from a feed.
 */

"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { trpc } from "@/lib/trpc/client";

interface UnsubscribeDialogProps {
  isOpen: boolean;
  subscriptionId: string;
  feedTitle: string;
  /** Collections are deleted rather than unsubscribed from; their articles stay put. */
  isCollection?: boolean;
  /** Email subscriptions offer to block the sender too. */
  isEmail?: boolean;
  isLoading: boolean;
  onConfirm: (options: { blockSender: boolean }) => void;
  onCancel: () => void;
}

export function UnsubscribeDialog({
  subscriptionId,
  feedTitle,
  isCollection,
  isEmail,
  onConfirm,
  onCancel,
  ...props
}: UnsubscribeDialogProps) {
  // Blocking is opt-in: the sender's address may also send mail the user
  // still needs, like a newsletter platform's login codes (#1964).
  const [blockSender, setBlockSender] = useState(false);
  const emailSenderQuery = trpc.subscriptions.getEmailSender.useQuery(
    { id: subscriptionId },
    { enabled: props.isOpen && !!isEmail && subscriptionId !== "" }
  );
  const emailSender = isEmail ? emailSenderQuery.data?.emailSender : null;

  const handleConfirm = () => {
    onConfirm({ blockSender: blockSender && !!emailSender });
    setBlockSender(false);
  };
  const handleCancel = () => {
    onCancel();
    setBlockSender(false);
  };

  if (isCollection) {
    return (
      <ConfirmDialog
        title="Delete collection?"
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        {...props}
      >
        Delete <span className="text-body font-medium">{feedTitle}</span>? Its articles stay in
        their feeds and in Saved. Ones from feeds you&apos;ve unsubscribed from disappear unless
        they&apos;re starred.
      </ConfirmDialog>
    );
  }
  if (isEmail) {
    return (
      <ConfirmDialog
        title="Unsubscribe from newsletter?"
        confirmLabel="Unsubscribe"
        confirmVariant="danger"
        onConfirm={handleConfirm}
        onCancel={handleCancel}
        options={
          emailSender && (
            <label className="mt-4 flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={blockSender}
                onChange={(e) => setBlockSender(e.target.checked)}
                className="text-accent border-edge-input mt-0.5 h-4 w-4 rounded dark:bg-zinc-800"
              />
              <span className="ui-text-sm text-body">
                Also block <span className="font-medium break-all">{emailSender}</span>, rejecting
                all future emails from it. Don&apos;t block an address you get login codes from.
              </span>
            </label>
          )
        }
        {...props}
      >
        Unsubscribe from <span className="text-body font-medium">{feedTitle}</span>? We&apos;ll ask
        the sender to stop emailing you, but if they email you again, you&apos;ll be resubscribed
        unless you block them.
      </ConfirmDialog>
    );
  }
  return (
    <ConfirmDialog
      title="Unsubscribe from feed?"
      confirmLabel="Unsubscribe"
      confirmVariant="danger"
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      {...props}
    >
      Are you sure you want to unsubscribe from{" "}
      <span className="text-body font-medium">{feedTitle}</span>? You can always resubscribe later.
    </ConfirmDialog>
  );
}
