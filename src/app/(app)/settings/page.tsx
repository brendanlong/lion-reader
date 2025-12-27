/**
 * Settings Page
 *
 * Main account settings page showing user info, linked accounts,
 * change password form, and OPML import/export functionality.
 */

"use client";

import { useState, useEffect, useMemo } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";
import {
  OpmlImportExport,
  LinkedAccounts,
  KeyboardShortcutsSettings,
  TagManagement,
  BookmarkletSettings,
} from "@/components/settings";

export default function SettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const userQuery = trpc.auth.me.useQuery();

  // Handle link success/error query params
  const linkedProvider = searchParams.get("linked");
  const linkError = searchParams.get("link_error");

  // Map error codes to user-friendly messages
  const linkErrorMessage = useMemo(() => {
    if (!linkError) return null;

    const errorMessages: Record<string, string> = {
      invalid_state: "Account linking failed. Please try again.",
      callback_failed: "Failed to complete account linking. Please try again.",
      provider_not_configured: "This provider is not available.",
      already_linked: "This account is already linked to another user.",
    };

    return errorMessages[linkError] || "An error occurred while linking your account.";
  }, [linkError]);

  const linkSuccessMessage = useMemo(() => {
    if (!linkedProvider) return null;
    const providerName =
      linkedProvider === "google"
        ? "Google"
        : linkedProvider === "apple"
          ? "Apple"
          : linkedProvider;
    return `${providerName} account linked successfully!`;
  }, [linkedProvider]);

  // Clear query params after showing message
  useEffect(() => {
    if (linkedProvider || linkError) {
      const timeoutId = setTimeout(() => {
        router.replace("/settings", { scroll: false });
      }, 5000);
      return () => clearTimeout(timeoutId);
    }
  }, [linkedProvider, linkError, router]);

  return (
    <div className="space-y-8">
      {/* Link Success/Error Messages */}
      {linkSuccessMessage && <Alert variant="success">{linkSuccessMessage}</Alert>}

      {linkErrorMessage && <Alert variant="error">{linkErrorMessage}</Alert>}

      {/* Account Information Section */}
      <section>
        <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
          Account Information
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          {userQuery.isLoading ? (
            <div className="space-y-4">
              <div className="h-5 w-48 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
              <div className="h-5 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            </div>
          ) : userQuery.error ? (
            <p className="text-sm text-red-600 dark:text-red-400">
              Failed to load account information
            </p>
          ) : (
            <dl className="space-y-4">
              <div>
                <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Email</dt>
                <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">
                  {userQuery.data?.user.email}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  Member since
                </dt>
                <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">
                  {userQuery.data?.user.createdAt
                    ? new Date(userQuery.data.user.createdAt).toLocaleDateString("en-US", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })
                    : "Unknown"}
                </dd>
              </div>
              <div>
                <dt className="text-sm font-medium text-zinc-500 dark:text-zinc-400">
                  Email verified
                </dt>
                <dd className="mt-1 text-sm text-zinc-900 dark:text-zinc-50">
                  {userQuery.data?.user.emailVerifiedAt ? (
                    <span className="inline-flex items-center text-green-600 dark:text-green-400">
                      <svg
                        className="mr-1 h-4 w-4"
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
                      Verified
                    </span>
                  ) : (
                    <span className="text-zinc-500 dark:text-zinc-400">Not verified</span>
                  )}
                </dd>
              </div>
            </dl>
          )}
        </div>
      </section>

      {/* Linked Accounts Section */}
      <LinkedAccounts />

      {/* Tags Section */}
      <TagManagement />

      {/* Change Password Section */}
      <ChangePasswordForm />

      {/* OPML Import/Export Section */}
      <OpmlImportExport />

      {/* Bookmarklet Section */}
      <BookmarkletSettings />

      {/* Keyboard Shortcuts Section */}
      <KeyboardShortcutsSettings />
    </div>
  );
}

function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{
    currentPassword?: string;
    newPassword?: string;
    confirmPassword?: string;
    form?: string;
  }>({});
  const [successMessage, setSuccessMessage] = useState("");

  const changePasswordMutation = trpc.users["me.changePassword"].useMutation({
    onSuccess: () => {
      setSuccessMessage("Password changed successfully");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setErrors({});
    },
    onError: (error) => {
      if (error.message.includes("Current password is incorrect")) {
        setErrors({ currentPassword: "Current password is incorrect" });
      } else {
        setErrors({ form: error.message || "Failed to change password" });
      }
      setSuccessMessage("");
    },
  });

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!currentPassword) {
      newErrors.currentPassword = "Current password is required";
    }

    if (!newPassword) {
      newErrors.newPassword = "New password is required";
    } else if (newPassword.length < 8) {
      newErrors.newPassword = "New password must be at least 8 characters";
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = "Please confirm your new password";
    } else if (newPassword !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSuccessMessage("");

    if (!validateForm()) {
      return;
    }

    changePasswordMutation.mutate({ currentPassword, newPassword });
  };

  return (
    <section>
      <h2 className="mb-4 text-lg font-semibold text-zinc-900 dark:text-zinc-50">
        Change Password
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {successMessage && (
          <Alert variant="success" className="mb-4">
            {successMessage}
          </Alert>
        )}

        {errors.form && (
          <Alert variant="error" className="mb-4">
            {errors.form}
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            id="current-password"
            type="password"
            label="Current password"
            placeholder="Enter your current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            error={errors.currentPassword}
            autoComplete="current-password"
            disabled={changePasswordMutation.isPending}
          />

          <Input
            id="new-password"
            type="password"
            label="New password"
            placeholder="Enter your new password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={errors.newPassword}
            autoComplete="new-password"
            disabled={changePasswordMutation.isPending}
          />

          <Input
            id="confirm-password"
            type="password"
            label="Confirm new password"
            placeholder="Confirm your new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={errors.confirmPassword}
            autoComplete="new-password"
            disabled={changePasswordMutation.isPending}
          />

          <div className="pt-2">
            <Button type="submit" loading={changePasswordMutation.isPending}>
              Change password
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}
