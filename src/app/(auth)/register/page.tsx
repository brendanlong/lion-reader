/**
 * Registration Page
 *
 * Allows new users to create an account with email/password or OAuth.
 *
 * IMPORTANT INVARIANT: this page must submit via tRPC (see `registerMutation`), NEVER a
 * plain-HTML `POST` to `/register`. `src/proxy.ts` method-splits this URL —
 * `POST /register` is rewritten to the OAuth Dynamic Client Registration handler
 * `/oauth/register` (a HACK to satisfy claude.ai's root-path synthesis; see the
 * comment in proxy.ts and anthropics/claude-ai-mcp#341). A form `POST` here
 * would be silently hijacked into OAuth registration.
 */

"use client";

import { useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { AuthFooter } from "@/components/auth/AuthFooter";

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Get invite token from URL query parameter
  const inviteToken = searchParams.get("invite");

  // Fetch signup configuration
  const { data: signupConfigData, isLoading: isLoadingConfig } = trpc.auth.signupConfig.useQuery();
  const euRestricted = signupConfigData?.euRestricted ?? false;

  // On EU-restricted instances, warn EU users up front that they can't sign up
  // here and point them at self-hosting.
  const euNotice = euRestricted ? (
    <Alert variant="warning" className="mb-4">
      <span className="font-semibold">Not available in the European Union.</span> Our
      <a href="/privacy" target="_blank">
        privacy policy
      </a>{" "}
      is unusually-strict, but EU requirements would additionally require us to
      <a href="https://www.activemind.legal/guides/fine-eu-representative/">retain a laywer</a>,
      which isn&apos;t viable for a free project. You&apos;re welcome to{" "}
      <a
        href="https://github.com/brendanlong/lion-reader"
        target="_blank"
        rel="noopener noreferrer"
        className="underline"
      >
        self-host Lion Reader
      </a>{" "}
      instead.
    </Alert>
  ) : null;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    confirmPassword?: string;
    form?: string;
  }>({});

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: () => {
      // Redirect to login with success message
      router.push("/login?registered=true");
    },
    onError: (error) => {
      // Handle specific error codes
      if (error.data?.code === "CONFLICT") {
        setErrors({ email: "An account with this email already exists" });
      } else if (error.data?.code === "BAD_REQUEST") {
        // Parse validation errors from the message
        const message = error.message.toLowerCase();
        if (message.includes("email")) {
          setErrors({ email: error.message });
        } else if (message.includes("password")) {
          setErrors({ password: error.message });
        } else {
          setErrors({ form: error.message });
        }
      } else {
        setErrors({
          form: error.message || "An error occurred. Please try again.",
        });
      }
    },
  });

  const validateForm = (): boolean => {
    const newErrors: typeof errors = {};

    if (!email.trim()) {
      newErrors.email = "Email is required";
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      newErrors.email = "Please enter a valid email address";
    }

    if (!password) {
      newErrors.password = "Password is required";
    } else if (password.length < 8) {
      newErrors.password = "Password must be at least 8 characters";
    } else if (password.length > 128) {
      newErrors.password = "Password must be less than 128 characters";
    }

    if (!confirmPassword) {
      newErrors.confirmPassword = "Please confirm your password";
    } else if (password !== confirmPassword) {
      newErrors.confirmPassword = "Passwords do not match";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    registerMutation.mutate({
      email,
      password,
      inviteToken: inviteToken ?? undefined,
    });
  };

  // Which providers may sign up depends on whether an invite is present:
  // with a token, the full allowlist applies; without one, only public providers.
  const effectiveProviders = inviteToken
    ? (signupConfigData?.allowedSignupProviders ?? [])
    : (signupConfigData?.publicSignupProviders ?? []);
  const isEmailAllowed = effectiveProviders.includes("email");

  // Show loading state while fetching config
  if (isLoadingConfig) {
    return (
      <div>
        <h2 className="ui-text-xl text-body mb-6 font-semibold">Create your account</h2>
        <div className="text-muted text-center">Loading...</div>
      </div>
    );
  }

  // No provider can sign up in this context (no invite present and nothing is
  // public). With a token the allowlist is never empty, so this only triggers
  // for invite-required instances reached without an invite link.
  if (effectiveProviders.length === 0) {
    return (
      <div>
        <h2 className="ui-text-xl text-body mb-6 font-semibold">Invite Required</h2>
        {euNotice}
        <Alert variant="error" className="mb-4">
          This instance requires an invite to sign up. Please contact an administrator to request an
          invite.
        </Alert>
        <p className="ui-text-sm text-muted mt-6 text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-body font-medium hover:underline">
            Sign in
          </Link>
        </p>

        <AuthFooter />
      </div>
    );
  }

  return (
    <div>
      <h2 className="ui-text-xl text-body mb-6 font-semibold">Create your account</h2>

      {euNotice}

      {errors.form && (
        <Alert variant="error" className="mb-4">
          {errors.form}
        </Alert>
      )}

      {/* OAuth Sign-up Options */}
      <OAuthButtons
        mode="signup"
        onError={(error) => setErrors({ form: error })}
        inviteToken={inviteToken ?? undefined}
        allowedProviders={effectiveProviders}
      />

      {isEmailAllowed && (
        <>
          {/* Divider */}
          <div className="relative my-6">
            <div className="absolute inset-0 flex items-center">
              <div className="border-edge-input w-full border-t" />
            </div>
            <div className="ui-text-sm relative flex justify-center">
              <span className="bg-surface text-muted px-2">Or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              id="email"
              type="email"
              label="Email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={errors.email}
              autoComplete="email"
              disabled={registerMutation.isPending}
            />

            <Input
              id="password"
              type="password"
              label="Password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={errors.password}
              autoComplete="new-password"
              disabled={registerMutation.isPending}
            />

            <Input
              id="confirm-password"
              type="password"
              label="Confirm password"
              placeholder="Confirm your password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              error={errors.confirmPassword}
              autoComplete="new-password"
              disabled={registerMutation.isPending}
            />

            <Button type="submit" className="w-full" loading={registerMutation.isPending}>
              Create account
            </Button>
          </form>
        </>
      )}

      <p className="ui-text-xs text-muted mt-4 text-center">
        By creating an account, you agree to our{" "}
        <Link href="/terms" className="hover:text-body underline">
          Terms of Service
        </Link>{" "}
        and{" "}
        <Link href="/privacy" className="hover:text-body underline">
          Privacy Policy
        </Link>
      </p>

      <p className="ui-text-sm text-muted mt-6 text-center">
        Already have an account?{" "}
        <Link href="/login" className="text-body font-medium hover:underline">
          Sign in
        </Link>
      </p>

      <AuthFooter />
    </div>
  );
}
