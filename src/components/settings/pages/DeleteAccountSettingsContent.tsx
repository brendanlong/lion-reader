/**
 * Delete Account Settings Content
 *
 * Allows users to permanently delete their account.
 * Requires typing "delete" as confirmation to prevent accidental deletion.
 */

"use client";

import { useState, useRef, useEffect } from "react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import {
  Dialog,
  DialogTitle,
  DialogDescription,
  DialogBody,
  DialogFooter,
} from "@/components/ui/dialog";

export default function DeleteAccountSettingsContent() {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  const deleteAccountMutation = trpc.users["me.deleteAccount"].useMutation({
    onSuccess: () => {
      // Redirect to login page after deletion
      window.location.href = "/login";
    },
    onError: (err) => {
      setError(err.message || "Failed to delete account");
      toast.error("Failed to delete account");
    },
  });

  // Focus the cancel button when dialog opens
  useEffect(() => {
    if (isDialogOpen) {
      cancelButtonRef.current?.focus();
    }
  }, [isDialogOpen]);

  const handleOpenDialog = () => {
    setConfirmation("");
    setError(null);
    setIsDialogOpen(true);
  };

  const handleClose = () => {
    if (deleteAccountMutation.isPending) return;
    setIsDialogOpen(false);
    setConfirmation("");
    setError(null);
  };

  const handleDelete = () => {
    if (confirmation !== "delete") {
      setError("Please type 'delete' to confirm");
      return;
    }
    setError(null);
    deleteAccountMutation.mutate({ confirmation });
  };

  const isConfirmed = confirmation === "delete";

  return (
    <div className="space-y-8">
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-red-600 dark:text-red-400">
          Delete Account
        </h2>
        <div className="rounded-lg border border-red-200 bg-white p-6 dark:border-red-900/50 dark:bg-zinc-900">
          <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
            Permanently delete your account and all associated data. This action cannot be undone.
          </p>
          <p className="ui-text-sm mt-2 text-zinc-600 dark:text-zinc-400">
            This will delete your subscriptions, reading history, starred items, tags, saved
            articles, email ingest addresses, score models, AI summaries, sessions, API tokens, and
            all other account data.
          </p>
          <div className="mt-4">
            <Button
              onClick={handleOpenDialog}
              className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
            >
              Delete account
            </Button>
          </div>
        </div>
      </section>

      <Dialog
        isOpen={isDialogOpen}
        onClose={handleClose}
        title="Delete account"
        titleId="delete-account-title"
      >
        <DialogTitle id="delete-account-title">Delete account?</DialogTitle>
        <DialogDescription>
          This action is permanent and cannot be undone. All your data will be deleted, including
          subscriptions, reading history, starred items, saved articles, and account settings.
        </DialogDescription>

        <DialogBody className="mt-4">
          {error && (
            <Alert variant="error" className="mb-4">
              {error}
            </Alert>
          )}
          <label
            htmlFor="delete-confirmation"
            className="ui-text-sm text-zinc-700 dark:text-zinc-300"
          >
            Type <span className="font-semibold">delete</span> to confirm:
          </label>
          <Input
            id="delete-confirmation"
            type="text"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            placeholder="delete"
            autoComplete="off"
            disabled={deleteAccountMutation.isPending}
            className="mt-2"
          />
        </DialogBody>

        <DialogFooter>
          <Button
            ref={cancelButtonRef}
            variant="secondary"
            onClick={handleClose}
            disabled={deleteAccountMutation.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            loading={deleteAccountMutation.isPending}
            disabled={!isConfirmed}
            className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:hover:bg-red-700"
          >
            Delete my account
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
