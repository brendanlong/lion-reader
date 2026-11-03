/**
 * Forgot Password Page
 *
 * Asks for an email address and has the server email it a reset link. The
 * confirmation is the same whether or not the address has an account.
 */

"use client";

import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { PageLink } from "@/components/ui/page-link";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const requestMutation = trpc.auth.requestPasswordReset.useMutation({
    onError: (err) => setError(err.message),
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    requestMutation.mutate({ email });
  };

  return (
    <div>
      <h2 className="ui-text-xl text-body mb-2 font-semibold">Reset your password</h2>

      {requestMutation.isSuccess ? (
        <Alert variant="success" className="mt-4">
          If there&apos;s an account for {email}, we&apos;ve emailed it a link to choose a new
          password.
        </Alert>
      ) : (
        <>
          <p className="ui-text-sm text-muted mb-6">
            Enter your account&apos;s email address and we&apos;ll send you a link to choose a new
            password.
          </p>

          {error && (
            <Alert variant="error" className="mb-4">
              {error}
            </Alert>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              id="email"
              type="email"
              label="Email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email"
              required
              disabled={requestMutation.isPending}
            />

            <Button type="submit" className="w-full" loading={requestMutation.isPending}>
              Send reset link
            </Button>
          </form>
        </>
      )}

      <p className="ui-text-sm text-muted mt-6 text-center">
        <PageLink href="/login" className="text-body font-medium hover:underline">
          Back to sign in
        </PageLink>
      </p>
    </div>
  );
}
