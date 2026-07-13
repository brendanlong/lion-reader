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
import { SettingsSection } from "@/components/settings/SettingsSection";
import { TextLink } from "@/components/ui/text-link";

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
    <SettingsSection title="Account Information">
      {userQuery.isLoading ? (
        <div className="space-y-4">
          <div className="bg-surface-muted h-5 w-48 animate-pulse rounded" />
          <div className="bg-surface-muted h-5 w-32 animate-pulse rounded" />
        </div>
      ) : userQuery.error ? (
        <p className="ui-text-sm text-danger">Failed to load account information</p>
      ) : (
        <dl className="space-y-4">
          <div>
            <dt className="ui-text-sm text-muted font-medium">Email</dt>
            <dd className="ui-text-sm text-strong mt-1">{userQuery.data?.user.email}</dd>
          </div>
          <div>
            <dt className="ui-text-sm text-muted font-medium">Member since</dt>
            <dd className="ui-text-sm text-strong mt-1">
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
            <dt className="ui-text-sm text-muted font-medium">Email verified</dt>
            <dd className="ui-text-sm text-strong mt-1">
              {userQuery.data?.user.emailVerifiedAt ? (
                <span className="text-success inline-flex items-center">
                  <CheckIcon className="mr-1 h-4 w-4" />
                  Verified
                </span>
              ) : (
                <span className="text-muted">Not verified</span>
              )}
            </dd>
          </div>
        </dl>
      )}
    </SettingsSection>
  );
}

function PasswordSection() {
  const linkedAccountsQuery = trpc.users["me.linkedAccounts"].useQuery();
  const hasPassword = linkedAccountsQuery.data?.hasPassword ?? true;

  if (linkedAccountsQuery.isLoading) {
    return (
      <SettingsSection title="Password">
        <div className="bg-surface-muted h-32 animate-pulse rounded" />
      </SettingsSection>
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
    <SettingsSection
      title={isSetMode ? "Set Password" : "Change Password"}
      description={
        isSetMode
          ? "Your account was created with OAuth. Set a password to also log in with your email and password."
          : undefined
      }
    >
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
    </SettingsSection>
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
      <SettingsSection
        title="Privacy & Legal"
        description="Learn more about how we collect, use, and protect your data."
      >
        <div className="flex gap-4">
          <TextLink href="/privacy" className="ui-text-sm">
            View Privacy Policy &rarr;
          </TextLink>
          <TextLink href="/terms" className="ui-text-sm">
            View Terms of Service &rarr;
          </TextLink>
        </div>
      </SettingsSection>

      {/* About Section - fully static */}
      <AboutSection />
    </div>
  );
}
