/**
 * UnsubscribeDialog Component
 *
 * Confirmation dialog for unsubscribing from a feed.
 */

"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { trpc } from "@/lib/trpc/client";

interface UnsubscribeDialogProps {
  isOpen: boolean;
  feedTitle: string;
  /** Collections are deleted rather than unsubscribed from; their articles stay put. */
  isCollection?: boolean;
  /** An email subscription's id, to offer blocking its sender too. */
  emailSubscriptionId?: string;
  isLoading: boolean;
  onConfirm: (options: { blockSender: boolean }) => void;
  onCancel: () => void;
}

export function UnsubscribeDialog(props: UnsubscribeDialogProps) {
  // Remounting on each open resets the block-sender choice.
  return <UnsubscribeDialogContent key={props.isOpen ? "open" : "closed"} {...props} />;
}

function UnsubscribeDialogContent({
  feedTitle,
  isCollection,
  emailSubscriptionId,
  onConfirm,
  ...props
}: UnsubscribeDialogProps) {
  if (isCollection) {
    return (
      <ConfirmDialog
        title="Delete collection?"
        confirmLabel="Delete"
        confirmVariant="danger"
        onConfirm={() => onConfirm({ blockSender: false })}
        {...props}
      >
        Delete <span className="text-body font-medium">{feedTitle}</span>? Its articles stay in
        their feeds and in Saved. Ones from feeds you&apos;ve unsubscribed from disappear unless
        they&apos;re starred.
      </ConfirmDialog>
    );
  }
  if (emailSubscriptionId) {
    return (
      <EmailUnsubscribeDialog
        feedTitle={feedTitle}
        subscriptionId={emailSubscriptionId}
        onConfirm={onConfirm}
        {...props}
      />
    );
  }
  return (
    <ConfirmDialog
      title="Unsubscribe from feed?"
      confirmLabel="Unsubscribe"
      confirmVariant="danger"
      onConfirm={() => onConfirm({ blockSender: false })}
      {...props}
    >
      Are you sure you want to unsubscribe from{" "}
      <span className="text-body font-medium">{feedTitle}</span>? You can always resubscribe later.
    </ConfirmDialog>
  );
}

function EmailUnsubscribeDialog({
  feedTitle,
  subscriptionId,
  onConfirm,
  ...props
}: Omit<UnsubscribeDialogProps, "isCollection" | "emailSubscriptionId"> & {
  subscriptionId: string;
}) {
  // Blocking is opt-in: the sender's address may also send mail the user
  // still needs, like a newsletter platform's login codes (#1964).
  const [blockSender, setBlockSender] = useState(false);
  const emailSenderQuery = trpc.subscriptions.getEmailSender.useQuery(
    { id: subscriptionId },
    { enabled: props.isOpen }
  );
  const emailSender = emailSenderQuery.data?.emailSender;

  return (
    <ConfirmDialog
      title="Unsubscribe from newsletter?"
      confirmLabel="Unsubscribe"
      confirmVariant="danger"
      onConfirm={() => onConfirm({ blockSender: blockSender && !!emailSender })}
      // Rendered (disabled) while the address loads, so it doesn't shift the
      // buttons under a click.
      options={
        <label className="mt-4 flex cursor-pointer items-start gap-3">
          <Checkbox
            checked={blockSender}
            disabled={!emailSender}
            onChange={(e) => setBlockSender(e.target.checked)}
            className="mt-1"
          />
          <span className="ui-text-sm text-body">
            Also block{" "}
            {emailSender ? (
              <span className="font-medium break-all">{emailSender}</span>
            ) : (
              "the sender"
            )}
            .
          </span>
        </label>
      }
      {...props}
    >
      Unsubscribe from <span className="text-body font-medium">{feedTitle}</span>? We&apos;ll ask
      the sender to stop emailing you, but if they email you again, you&apos;ll be resubscribed
      unless you block them.
    </ConfirmDialog>
  );
}
