/**
 * Login Page
 *
 * Allows users to sign in with their email and password, or with OAuth providers.
 */

"use client";

import { useState, useMemo, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { STATIC_CONFIG_QUERY_OPTIONS } from "@/lib/trpc/query-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert } from "@/components/ui/alert";
import { PageLink } from "@/components/ui/page-link";
import { OAuthButtons } from "@/components/auth/OAuthButtons";
import { AuthFooter } from "@/components/auth/AuthFooter";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { navigateAfterAuth } from "@/lib/navigation";
import {
  subscribeToOAuthCompletion,
  checkOAuthOnVisibilityChange,
  clearOAuthCompletion,
} from "@/lib/oauth-channel";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{
    email?: string;
    password?: string;
    form?: string;
  }>({});

  // Once login succeeds we start a router navigation into the app, but that
  // navigation renders the authenticated shell server-side and can take a
  // moment. `loginMutation.isPending` flips back to false as soon as the login
  // request resolves, so binding the button to it alone would briefly re-enable
  // the button during that navigation gap (looks like the click did nothing).
  // Keep this true from success until the component unmounts on navigation; it
  // is never reset back to false on the happy path. On error it stays false, so
  // the button re-enables for a retry.
  const [isRedirecting, setIsRedirecting] = useState(false);

  // Get success message from registration redirect
  const registered = searchParams.get("registered") === "true";

  // Fetch signup configuration to determine if signup link should be shown. The
  // auth layout server-prefetches and hydrates this query (#1328), so it resolves
  // as already-settled data on first render. The config is deploy-static, so
  // never refetch it (STATIC_CONFIG_QUERY_OPTIONS).
  const [signupConfigData] = trpc.auth.signupConfig.useSuspenseQuery(
    undefined,
    STATIC_CONFIG_QUERY_OPTIONS
  );

  // Listen for OAuth completion from other tabs/windows (PWA support for Firefox Android)
  // When OAuth happens in a separate browser window, this allows the PWA to detect completion
  useEffect(() => {
    const handleOAuthComplete = (message: { redirectTo: string }) => {
      // Clear the completion marker to prevent re-triggering
      clearOAuthCompletion();
      // Navigate to the redirect destination - the session cookie should already be set.
      // No need to touch `isRedirecting` here: that flag is about the email/password
      // submit button, whereas the OAuth buttons own their own loading state.
      // A new user is sent to the standalone /complete-signup (hard nav); an
      // existing user soft-navigates into the app.
      navigateAfterAuth(router, message.redirectTo);
    };

    // Subscribe to BroadcastChannel and storage events
    const unsubscribeBroadcast = subscribeToOAuthCompletion(handleOAuthComplete);

    // Also check when page becomes visible (handles case where PWA is backgrounded)
    const unsubscribeVisibility = checkOAuthOnVisibilityChange(handleOAuthComplete);

    return () => {
      unsubscribeBroadcast();
      unsubscribeVisibility();
    };
  }, [router]);

  // Get OAuth error from callback redirect and map to user-friendly message
  const oauthError = searchParams.get("error");
  const oauthErrorMessage = useMemo(() => {
    if (!oauthError) return null;

    const errorMessages: Record<string, string> = {
      invalid_state: "Authentication failed. Please try again.",
      callback_failed: "Failed to complete sign-in. Please try again.",
      provider_not_configured: "This sign-in method is not available.",
      signup_provider_not_allowed:
        "This sign-in method is not available for new accounts. If you already have an account, try a different sign-in method.",
      invite_required:
        "An invite is required to create an account. If you already have an account, try signing in with email and password instead.",
      invite_invalid: "The invite link is invalid. Please request a new invite.",
      invite_expired: "The invite link has expired. Please request a new invite.",
      invite_already_used: "This invite has already been used. Please request a new invite.",
    };

    return errorMessages[oauthError] || "An error occurred during sign-in. Please try again.";
  }, [oauthError]);

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: () => {
      // The server set the httpOnly session cookie on the login response;
      // nothing to persist client-side.

      // Get the redirect URL from query params or default to /all.
      // Sanitize to a same-origin path to prevent an open redirect.
      const redirectTo = safeRedirectPath(searchParams.get("redirect"));
      // Keep the button in its loading state through the (server-rendered)
      // navigation instead of letting it re-enable the instant isPending clears.
      setIsRedirecting(true);
      // Almost always /all (soft-nav into the app); guard the rare case where the
      // sanitized ?redirect target is a standalone page, which needs a hard nav.
      navigateAfterAuth(router, redirectTo);
    },
    onError: (error) => {
      // Handle specific error codes
      if (error.data?.code === "UNAUTHORIZED") {
        setErrors({ form: "Invalid email or password" });
      } else {
        setErrors({ form: error.message || "An error occurred. Please try again." });
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
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    loginMutation.mutate({ email, password });
  };

  // Show the loading state while the login request is in flight AND while the
  // post-success navigation into the app is happening.
  const isSubmitting = loginMutation.isPending || isRedirecting;

  return (
    <div>
      <h2 className="ui-text-xl text-body mb-6 font-semibold">Sign in to your account</h2>

      {registered && (
        <Alert variant="success" className="mb-4">
          Account created successfully. Please sign in.
        </Alert>
      )}

      {oauthErrorMessage && (
        <Alert variant="error" className="mb-4">
          {oauthErrorMessage}
        </Alert>
      )}

      {errors.form && (
        <Alert variant="error" className="mb-4">
          {errors.form}
        </Alert>
      )}

      {/* OAuth Sign-in Options */}
      <OAuthButtons mode="signin" onError={(error) => setErrors({ form: error })} />

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
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errors.password}
          autoComplete="current-password"
          disabled={isSubmitting}
        />

        <Button type="submit" className="w-full" loading={isSubmitting}>
          Sign in
        </Button>
      </form>

      {!signupConfigData.requiresInvite && (
        <p className="ui-text-sm text-muted mt-6 text-center">
          Don&apos;t have an account?{" "}
          <PageLink href="/register" className="text-body font-medium hover:underline">
            Create one
          </PageLink>
        </p>
      )}

      <AuthFooter />
    </div>
  );
}
