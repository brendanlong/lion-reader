/**
 * Reset Password Page
 *
 * Where the emailed reset link lands. Statically prerendered like the other
 * auth pages, so the token is read from `window.location` at submit time.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { PageLink } from "@/components/ui/page-link";
import { PASSWORD_MIN_LENGTH, passwordLengthError } from "@/lib/password";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{
    password?: string;
    confirmPassword?: string;
    form?: string;
  }>({});
  const [isRedirecting, setIsRedirecting] = useState(false);

  const resetMutation = trpc.auth.resetPassword.useMutation({
    onSuccess: () => {
      // The server signed us in with a new session cookie.
      setIsRedirecting(true);
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate hard nav across an auth boundary (see src/CLAUDE.md)
      window.location.href = "/";
    },
    onError: (err) => setErrors({ form: err.message }),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const newErrors: typeof errors = {};
    const passwordError = password ? passwordLengthError(password) : "Password is required";
    if (passwordError) {
      newErrors.password = passwordError;
    }
    if (password !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }
    setErrors(newErrors);
    if (Object.keys(newErrors).length > 0) {
      return;
    }

    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setErrors({ form: "This password reset link is incomplete." });
      return;
    }
    resetMutation.mutate({ token, newPassword: password });
  };

  const isSubmitting = resetMutation.isPending || isRedirecting;

  return (
    <div>
      <h2 className="ui-text-xl text-body mb-6 font-semibold">Choose a new password</h2>

      {errors.form && (
        <Alert variant="error" className="mb-4">
          {errors.form}{" "}
          <PageLink href="/forgot-password" className="underline">
            Send a new link
          </PageLink>
        </Alert>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <Input
          id="password"
          type="password"
          label="New password"
          placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          autoComplete="new-password"
          disabled={isSubmitting}
        />

        <Input
          id="confirm-password"
          type="password"
          label="Confirm new password"
          placeholder="Confirm your password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          error={errors.confirmPassword}
          autoComplete="new-password"
          disabled={isSubmitting}
        />

        <Button type="submit" className="w-full" loading={isSubmitting}>
          Set password and sign in
        </Button>
      </form>
    </div>
  );
}
