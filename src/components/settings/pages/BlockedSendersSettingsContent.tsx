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
import { Button, Alert } from "@/components/ui";

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
// Helper Functions
// ============================================================================

/**
 * Format a date relative to now (e.g., "2 days ago", "Jan 15, 2024")
 */
function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return "Today";
  } else if (diffDays === 1) {
    return "Yesterday";
  } else if (diffDays < 7) {
    return `${diffDays} days ago`;
  } else {
    return new Date(date).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
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
      <div className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        {blockedQuery.isLoading ? (
          <div className="p-6">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="mb-4 h-16 animate-pulse rounded bg-zinc-100 last:mb-0 dark:bg-zinc-800"
              />
            ))}
          </div>
        ) : blockedQuery.error ? (
          <div className="p-6">
            <Alert variant="error">Failed to load blocked senders. Please try again.</Alert>
          </div>
        ) : senders.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {senders.map((sender) => (
              <BlockedSenderRow key={sender.id} sender={sender} />
            ))}
          </div>
        )}
      </div>
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
      toast.error(error.message ?? "Failed to unblock sender");
    },
  });

  const handleUnblock = () => {
    unblockMutation.mutate({ id: sender.id });
  };

  return (
    <div className="p-4">
      {/* Unblock Confirmation Dialog */}
      {showUnblockConfirm && (
        <>
          <div
            className="fixed inset-0 z-50 bg-black/50"
            onClick={() => setShowUnblockConfirm(false)}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="w-full max-w-sm rounded-lg border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
              <h3 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Unblock Sender
              </h3>
              <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
                Are you sure you want to unblock{" "}
                <span className="font-medium">{sender.senderEmail}</span>? Future emails from this
                sender will be accepted again.
              </p>
              <div className="mt-4 flex justify-end gap-3">
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
              </div>
            </div>
          </div>
        </>
      )}

      {/* Main Row Content */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          {/* Sender Email */}
          <p className="font-medium text-zinc-900 dark:text-zinc-50">{sender.senderEmail}</p>

          {/* Metadata */}
          <div className="ui-text-sm mt-1 flex flex-wrap gap-x-4 gap-y-1 text-zinc-500 dark:text-zinc-400">
            <span>Blocked {formatRelativeDate(sender.blockedAt)}</span>
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
