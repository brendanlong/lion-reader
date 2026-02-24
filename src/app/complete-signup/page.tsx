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
      document.cookie = "session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";
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
        <h2 className="ui-text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Before you continue
        </h2>
        <p className="ui-text-sm mt-1 text-zinc-600 dark:text-zinc-400">
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
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:ring-zinc-400"
          />
          <span className="ui-text-sm text-zinc-700 dark:text-zinc-300">
            I have read and agree to the{" "}
            <a
              href="/terms"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-900 underline hover:text-zinc-700 dark:text-zinc-100 dark:hover:text-zinc-300"
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
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:ring-zinc-400"
          />
          <span className="ui-text-sm text-zinc-700 dark:text-zinc-300">
            I have read and agree to the{" "}
            <a
              href="/privacy"
              target="_blank"
              rel="noopener noreferrer"
              className="text-zinc-900 underline hover:text-zinc-700 dark:text-zinc-100 dark:hover:text-zinc-300"
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
            className="mt-0.5 h-5 w-5 shrink-0 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-50 dark:focus:ring-zinc-400"
          />
          <span className="ui-text-sm text-zinc-700 dark:text-zinc-300">
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
            className="ui-text-sm w-full text-center text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-300"
          >
            Delete my account instead
          </button>
        ) : (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 dark:border-red-900 dark:bg-red-950">
            <p className="ui-text-sm mb-3 text-red-800 dark:text-red-200">
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
                variant="primary"
                size="sm"
                onClick={handleDelete}
                loading={deleteMutation.isPending}
                disabled={!isDeleteConfirmed || deleteMutation.isPending}
                className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-600 dark:text-white dark:hover:bg-red-700"
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
