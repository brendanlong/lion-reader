/**
 * Complete Signup Page
 *
 * Requires users to accept Terms of Service, Privacy Policy, and confirm
 * they are not in the EU before they can use the app.
 * Also provides a button to delete their account if they don't want to proceed.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";

export default function CompleteSignupPage() {
  const router = useRouter();
  const [acceptedTos, setAcceptedTos] = useState(false);
  const [acceptedPrivacy, setAcceptedPrivacy] = useState(false);
  const [confirmedNotInEu, setConfirmedNotInEu] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const confirmMutation = trpc.auth.confirmSignup.useMutation({
    onSuccess: () => {
      router.push("/all");
      router.refresh();
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const deleteMutation = trpc.users["me.deleteAccount"].useMutation({
    onSuccess: () => {
      // The server cleared the httpOnly session cookie on the delete response.
      window.location.href = "/login";
    },
    onError: (err) => {
      setError(err.message);
    },
  });

  const allChecked = acceptedTos && acceptedPrivacy && confirmedNotInEu;
  const isDeleteConfirmed = deleteConfirmation === "delete";

  function handleConfirm() {
    setError(null);
    confirmMutation.mutate({
      acceptedTermsOfService: true,
      acceptedPrivacyPolicy: true,
      confirmedNotInEu: true,
    });
  }

  function handleDelete() {
    setError(null);
    deleteMutation.mutate({ confirmation: deleteConfirmation });
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="ui-text-lg text-body font-semibold">Before you continue</h2>
        <p className="ui-text-sm text-muted mt-1">
          Please review and accept the following to complete your account setup.
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="space-y-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={acceptedTos}
            onChange={(e) => setAcceptedTos(e.target.checked)}
            className="text-body border-edge-input focus:ring-focus mt-0.5 h-5 w-5 shrink-0 rounded dark:bg-zinc-800"
          />
          <span className="ui-text-sm text-body">
            I have read and agree to the{" "}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body hover:text-body underline"
            >
              Terms of Service
            </a>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={acceptedPrivacy}
            onChange={(e) => setAcceptedPrivacy(e.target.checked)}
            className="text-body border-edge-input focus:ring-focus mt-0.5 h-5 w-5 shrink-0 rounded dark:bg-zinc-800"
          />
          <span className="ui-text-sm text-body">
            I have read and agree to the{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-body hover:text-body underline"
            >
              Privacy Policy
            </a>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={confirmedNotInEu}
            onChange={(e) => setConfirmedNotInEu(e.target.checked)}
            className="text-body border-edge-input focus:ring-focus mt-0.5 h-5 w-5 shrink-0 rounded dark:bg-zinc-800"
          />
          <span className="ui-text-sm text-body">
            I confirm that I am not located in the European Union
          </span>
        </label>
      </div>

      <div className="space-y-3">
        <Button
          onClick={handleConfirm}
          disabled={!allChecked || confirmMutation.isPending}
          loading={confirmMutation.isPending}
          className="w-full"
        >
          Confirm and continue
        </Button>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="ui-text-sm text-muted hover:text-body w-full text-center underline"
          >
            Delete my account instead
          </button>
        ) : (
          <div className="border-danger-border bg-danger-subtle rounded-md border p-4">
            <p className="ui-text-sm text-danger-subtle-foreground mb-3">
              This will permanently delete your account and all associated data. Type{" "}
              <span className="font-semibold">delete</span> to confirm.
            </p>
            <Input
              type="text"
              value={deleteConfirmation}
              onChange={(e) => setDeleteConfirmation(e.target.value)}
              placeholder="delete"
              autoComplete="off"
              disabled={deleteMutation.isPending}
              className="mb-3"
            />
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setShowDeleteConfirm(false);
                  setDeleteConfirmation("");
                }}
                disabled={deleteMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleDelete}
                loading={deleteMutation.isPending}
                disabled={!isDeleteConfirmed || deleteMutation.isPending}
              >
                Delete account
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
