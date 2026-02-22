/**
 * Account Settings Content
 *
 * Main account settings page content showing user info, linked accounts,
 * change password form, and OPML import/export functionality.
 *
 * Each section handles its own loading state to show static content (titles,
 * descriptions) immediately while dynamic content loads.
 */

"use client";

import { useState, useEffect, useMemo, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc/client";
import { clientReplace } from "@/lib/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { CheckIcon } from "@/components/ui/icon-button";
import { LinkedAccounts } from "@/components/settings/LinkedAccounts";
import { KeyboardShortcutsSettings } from "@/components/settings/KeyboardShortcutsSettings";
import { AboutSection } from "@/components/settings/AboutSection";

/**
 * Handles OAuth link success/error messages from query params.
 * Wrapped in Suspense because useSearchParams requires it.
 */
function OAuthMessages() {
  const searchParams = useSearchParams();

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
        clientReplace("/settings");
      }, 5000);
      return () => clearTimeout(timeoutId);
    }
  }, [linkedProvider, linkError]);

  if (!linkSuccessMessage && !linkErrorMessage) {
    return null;
  }

  return (
    <>
      {linkSuccessMessage && <Alert variant="success">{linkSuccessMessage}</Alert>}
      {linkErrorMessage && <Alert variant="error">{linkErrorMessage}</Alert>}
    </>
  );
}

function AccountInfoSection() {
  const userQuery = trpc.auth.me.useQuery();

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        Account Information
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {userQuery.isLoading ? (
          <div className="space-y-4">
            <div className="h-5 w-48 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
            <div className="h-5 w-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
          </div>
        ) : userQuery.error ? (
          <p className="ui-text-sm text-red-600 dark:text-red-400">
            Failed to load account information
          </p>
        ) : (
          <dl className="space-y-4">
            <div>
              <dt className="ui-text-sm font-medium text-zinc-500 dark:text-zinc-400">Email</dt>
              <dd className="ui-text-sm mt-1 text-zinc-900 dark:text-zinc-50">
                {userQuery.data?.user.email}
              </dd>
            </div>
            <div>
              <dt className="ui-text-sm font-medium text-zinc-500 dark:text-zinc-400">
                Member since
              </dt>
              <dd className="ui-text-sm mt-1 text-zinc-900 dark:text-zinc-50">
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
              <dt className="ui-text-sm font-medium text-zinc-500 dark:text-zinc-400">
                Email verified
              </dt>
              <dd className="ui-text-sm mt-1 text-zinc-900 dark:text-zinc-50">
                {userQuery.data?.user.emailVerifiedAt ? (
                  <span className="inline-flex items-center text-green-600 dark:text-green-400">
                    <CheckIcon className="mr-1 h-4 w-4" />
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
  );
}

function PasswordSection() {
  const linkedAccountsQuery = trpc.users["me.linkedAccounts"].useQuery();
  const hasPassword = linkedAccountsQuery.data?.hasPassword ?? true;

  if (linkedAccountsQuery.isLoading) {
    return (
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">Password</h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <div className="h-32 animate-pulse rounded bg-zinc-100 dark:bg-zinc-800" />
        </div>
      </section>
    );
  }

  return (
    <PasswordForm
      mode={hasPassword ? "change" : "set"}
      onSuccess={() => linkedAccountsQuery.refetch()}
    />
  );
}

function PasswordForm({ mode, onSuccess }: { mode: "set" | "change"; onSuccess: () => void }) {
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

  const isSetMode = mode === "set";

  const setPasswordMutation = trpc.users["me.setPassword"].useMutation({
    onSuccess: () => {
      setSuccessMessage("Password set successfully");
      setNewPassword("");
      setConfirmPassword("");
      setErrors({});
      onSuccess();
    },
    onError: (error) => {
      setErrors({ form: error.message || "Failed to set password" });
      setSuccessMessage("");
      toast.error("Failed to set password");
    },
  });

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
      toast.error("Failed to change password");
    },
  });

  const mutation = isSetMode ? setPasswordMutation : changePasswordMutation;

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!isSetMode && !currentPassword) {
      newErrors.currentPassword = "Current password is required";
    }

    if (!newPassword) {
      newErrors.newPassword = `${isSetMode ? "Password" : "New password"} is required`;
    } else if (newPassword.length < 8) {
      newErrors.newPassword = `${isSetMode ? "Password" : "New password"} must be at least 8 characters`;
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = `Please confirm your ${isSetMode ? "" : "new "}password`;
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

    if (isSetMode) {
      setPasswordMutation.mutate({ newPassword });
    } else {
      changePasswordMutation.mutate({ currentPassword, newPassword });
    }
  };

  return (
    <section>
      <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
        {isSetMode ? "Set Password" : "Change Password"}
      </h2>
      <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
        {isSetMode && (
          <p className="ui-text-sm mb-4 text-zinc-600 dark:text-zinc-400">
            Your account was created with OAuth. Set a password to also log in with your email and
            password.
          </p>
        )}

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
          {!isSetMode && (
            <Input
              id="current-password"
              type="password"
              label="Current password"
              placeholder="Enter your current password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              error={errors.currentPassword}
              autoComplete="current-password"
              disabled={mutation.isPending}
            />
          )}

          <Input
            id="new-password"
            type="password"
            label={isSetMode ? "Password" : "New password"}
            placeholder={isSetMode ? "Enter a password" : "Enter your new password"}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            error={errors.newPassword}
            autoComplete="new-password"
            disabled={mutation.isPending}
          />

          <Input
            id="confirm-password"
            type="password"
            label={isSetMode ? "Confirm password" : "Confirm new password"}
            placeholder={isSetMode ? "Confirm your password" : "Confirm your new password"}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            error={errors.confirmPassword}
            autoComplete="new-password"
            disabled={mutation.isPending}
          />

          <div className="pt-2">
            <Button type="submit" loading={mutation.isPending}>
              {isSetMode ? "Set password" : "Change password"}
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

export default function AccountSettingsContent() {
  return (
    <div className="space-y-8">
      {/* OAuth link success/error messages (needs Suspense for useSearchParams) */}
      <Suspense fallback={null}>
        <OAuthMessages />
      </Suspense>

      {/* Account Information Section - shows title immediately, content loads inline */}
      <AccountInfoSection />

      {/* Linked Accounts Section - uses SettingsSection which shows title during load */}
      <LinkedAccounts />

      {/* Password Section - shows title immediately, content loads inline */}
      <PasswordSection />

      {/* Keyboard Shortcuts Section - fully static */}
      <KeyboardShortcutsSettings />

      {/* Privacy & Legal Section - fully static */}
      <section>
        <h2 className="ui-text-lg mb-4 font-semibold text-zinc-900 dark:text-zinc-50">
          Privacy & Legal
        </h2>
        <div className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900">
          <p className="ui-text-sm text-zinc-600 dark:text-zinc-400">
            Learn more about how we collect, use, and protect your data.
          </p>
          <div className="mt-4 flex gap-4">
            <a
              href="/privacy"
              className="ui-text-sm text-accent hover:text-accent-hover font-medium"
            >
              View Privacy Policy &rarr;
            </a>
            <a href="/terms" className="ui-text-sm text-accent hover:text-accent-hover font-medium">
              View Terms of Service &rarr;
            </a>
          </div>
        </div>
      </section>

      {/* About Section - fully static */}
      <AboutSection />
    </div>
  );
}
