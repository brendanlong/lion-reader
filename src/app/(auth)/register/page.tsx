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
import { useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { STATIC_CONFIG_QUERY_OPTIONS } from "@/lib/trpc/query-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { PageLink } from "@/components/ui/page-link";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { AuthFooter } from "@/components/auth/AuthFooter";
import { EuRestrictionReason } from "@/components/auth/EuRestrictionNotice";

export default function RegisterPage() {
  return (
    <Suspense>
      <RegisterForm />
    </Suspense>
  );
}

function RegisterForm() {
  const searchParams = useSearchParams();

  // Get invite token from URL query parameter
  const inviteToken = searchParams.get("invite");

  // Fetch signup configuration. The auth layout server-prefetches and hydrates
  // this query (#1328), so it resolves as already-settled data on first render —
  // useSuspenseQuery guarantees defined data without a client-side loading state.
  // The config is deploy-static, so never refetch it (STATIC_CONFIG_QUERY_OPTIONS).
  const [signupConfigData] = trpc.auth.signupConfig.useSuspenseQuery(
    undefined,
    STATIC_CONFIG_QUERY_OPTIONS
  );
  const euRestricted = signupConfigData.euRestricted;

  // On EU-restricted instances, warn EU users up front that they can't sign up
  // here and point them at self-hosting.
  const euNotice = euRestricted ? (
    <Alert variant="warning" className="mb-4">
      <span className="font-semibold">Not available in the European Union.</span>{" "}
      <EuRestrictionReason />
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

  // Registration succeeding logs the user straight in (the server creates a
  // session and sets the httpOnly cookie on the response). A brand-new email
  // account still has to accept ToS/Privacy (and, on EU-restricted instances,
  // the not-in-EU cert) before the app shell will let it in, so we send them to
  // /complete-signup rather than bouncing back to /login to re-enter the
  // credentials they just chose. That navigation renders a server-side page and
  // takes a moment, during which `registerMutation.isPending` has already
  // cleared — keep the button in its loading state through it via this flag. It
  // is never reset on the happy path (the component unmounts on navigation); on
  // error it stays false so the button re-enables for a retry.
  const [isRedirecting, setIsRedirecting] = useState(false);

  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: () => {
      // The server already set the httpOnly session cookie, so the user is
      // signed in — go straight to the confirmation step (which leads into the
      // app) instead of asking them to sign in again. This is unconditionally
      // where a new email account goes: the (app) layout redirects any
      // not-yet-confirmed user to /complete-signup anyway.
      setIsRedirecting(true);
      // /complete-signup is a standalone page outside the SPA shell, so
      // hard-navigate (a full document load) rather than an RSC soft-nav.
      window.location.href = "/complete-signup";
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

  // Show the loading state while the request is in flight AND while the
  // post-success navigation into the app is happening.
  const isSubmitting = registerMutation.isPending || isRedirecting;

  // Which providers may sign up depends on whether an invite is present:
  // with a token, the full allowlist applies; without one, only public providers.
  const effectiveProviders = inviteToken
    ? signupConfigData.allowedSignupProviders
    : signupConfigData.publicSignupProviders;
  const isEmailAllowed = effectiveProviders.includes("email");

  // No provider can sign up in this context (no invite present and nothing is
  // public). With a token the allowlist is never empty, so this only triggers
  // for invite-required instances reached without an invite link.
  if (effectiveProviders.length === 0) {
    return (
      <div>
        <h2 className="ui-text-xl text-body mb-6 font-semibold">Invite Required</h2>
        <Alert variant="error" className="mb-4">
          This instance requires an invite to sign up. Please contact an administrator to request an
          invite.
        </Alert>
        <p className="ui-text-sm text-muted mt-6 text-center">
          Already have an account?{" "}
          <PageLink href="/login" className="text-body font-medium hover:underline">
            Sign in
          </PageLink>
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
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
              disabled={isSubmitting}
            />

            <Button type="submit" className="w-full" loading={isSubmitting}>
              Create account
            </Button>
          </form>
        </>
      )}

      <p className="ui-text-xs text-muted mt-4 text-center">
        By creating an account, you agree to our{" "}
        <PageLink href="/terms" className="hover:text-body underline">
          Terms of Service
        </PageLink>{" "}
        and{" "}
        <PageLink href="/privacy" className="hover:text-body underline">
          Privacy Policy
        </PageLink>
      </p>

      <p className="ui-text-sm text-muted mt-6 text-center">
        Already have an account?{" "}
        <PageLink href="/login" className="text-body font-medium hover:underline">
          Sign in
        </PageLink>
      </p>

      <AuthFooter />
    </div>
  );
}
