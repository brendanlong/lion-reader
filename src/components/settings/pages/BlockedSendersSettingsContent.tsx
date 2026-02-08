/**
 * Blocked Senders Settings Page
 *
 * Displays blocked email senders and allows users to unblock them.
 * Senders are blocked when unsubscribing from email newsletter feeds.
 */

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SettingsListContainer } from "@/components/settings/SettingsListContainer";
import { formatRelativeTime } from "@/lib/format";

// ============================================================================
// Types
// ============================================================================

interface BlockedSender {
  id: string;
  senderEmail: string;
  blockedAt: Date;
  unsubscribeSentAt: Date | null;
}

// ============================================================================
// Main Component
// ============================================================================

export default function BlockedSendersSettingsContent() {
  const blockedQuery = trpc.blockedSenders.list.useQuery();

  const senders = blockedQuery.data?.items ?? [];

  return (
    <div>
      {/* Page Header */}
      <div className="mb-6">
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Blocked Senders
        </h2>
        <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
          These senders were blocked when you unsubscribed from their newsletters. Emails from
          blocked senders are automatically rejected.
        </p>
      </div>

      {/* Blocked Senders List */}
      <SettingsListContainer
        items={senders}
        isLoading={blockedQuery.isLoading}
        error={blockedQuery.error}
        errorMessage="Failed to load blocked senders. Please try again."
        skeletonCount={3}
        skeletonHeight="h-16"
        emptyState={<EmptyState />}
        renderItem={(sender) => <BlockedSenderRow key={sender.id} sender={sender} />}
      />
    </div>
  );
}

// ============================================================================
// Empty State
// ============================================================================

function EmptyState() {
  return (
    <div className="p-8 text-center">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-800">
        <svg
          className="h-6 w-6 text-zinc-400 dark:text-zinc-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"
          />
        </svg>
      </div>
      <h3 className="ui-text-sm mt-4 font-medium text-zinc-900 dark:text-zinc-50">
        No blocked senders
      </h3>
      <p className="ui-text-sm mt-1 text-zinc-500 dark:text-zinc-400">
        When you unsubscribe from a newsletter, the sender will be added here to prevent future
        emails.
      </p>
    </div>
  );
}

// ============================================================================
// Blocked Sender Row
// ============================================================================

interface BlockedSenderRowProps {
  sender: BlockedSender;
}

function BlockedSenderRow({ sender }: BlockedSenderRowProps) {
  const [showUnblockConfirm, setShowUnblockConfirm] = useState(false);

  const utils = trpc.useUtils();

  const unblockMutation = trpc.blockedSenders.unblock.useMutation({
    onSuccess: () => {
      setShowUnblockConfirm(false);
      utils.blockedSenders.list.invalidate();
      toast.success("Sender unblocked");
    },
    onError: (error) => {
      toast.error(error.message || "Failed to unblock sender");
    },
  });

  const handleUnblock = () => {
    unblockMutation.mutate({ id: sender.id });
  };

  return (
    <div className="p-4">
      {/* Unblock Confirmation Dialog */}
      <Dialog
        isOpen={showUnblockConfirm}
        onClose={() => setShowUnblockConfirm(false)}
        title="Unblock Sender"
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>Unblock Sender</DialogTitle>
          <DialogDescription>
            Are you sure you want to unblock{" "}
            <span className="font-medium">{sender.senderEmail}</span>? Future emails from this
            sender will be accepted again.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="secondary"
            onClick={() => setShowUnblockConfirm(false)}
            disabled={unblockMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={handleUnblock} loading={unblockMutation.isPending}>
            Unblock
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Main Row Content */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Sender Email */}
          <p className="font-medium text-zinc-900 dark:text-zinc-50">{sender.senderEmail}</p>

          {/* Metadata */}
          <div className="ui-text-sm mt-1 flex flex-wrap gap-x-4 gap-y-1 text-zinc-500 dark:text-zinc-400">
            <span>Blocked {formatRelativeTime(sender.blockedAt)}</span>
            {sender.unsubscribeSentAt && (
              <span className="flex items-center gap-1">
                <svg
                  className="h-3.5 w-3.5 text-green-600 dark:text-green-400"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 13l4 4L19 7"
                  />
                </svg>
                Unsubscribe sent
              </span>
            )}
          </div>
        </div>

        {/* Unblock Button */}
        <Button variant="secondary" size="sm" onClick={() => setShowUnblockConfirm(true)}>
          Unblock
        </Button>
      </div>
    </div>
  );
}
