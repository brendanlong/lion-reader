/**
 * Login Page
 *
 * Allows users to sign in with their email and password, or with OAuth providers.
 */

"use client";

import { useState, useMemo, useEffect, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { Button, Input, Alert } from "@/components/ui";
import { GoogleSignInButton, AppleSignInButton, AuthFooter } from "@/components/auth";
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

  // Get success message from registration redirect
  const registered = searchParams.get("registered") === "true";

  // Fetch signup configuration to determine if signup link should be shown
  const { data: signupConfigData } = trpc.auth.signupConfig.useQuery();

  // Listen for OAuth completion from other tabs/windows (PWA support for Firefox Android)
  // When OAuth happens in a separate browser window, this allows the PWA to detect completion
  useEffect(() => {
    const handleOAuthComplete = (message: { redirectTo: string }) => {
      // Clear the completion marker to prevent re-triggering
      clearOAuthCompletion();
      // Navigate to the redirect destination - the session cookie should already be set
      router.push(message.redirectTo);
      router.refresh();
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
      invite_required:
        "An invite is required to create an account. If you already have an account, try signing in with email and password instead.",
      invite_invalid: "The invite link is invalid. Please request a new invite.",
      invite_expired: "The invite link has expired. Please request a new invite.",
      invite_already_used: "This invite has already been used. Please request a new invite.",
    };

    return errorMessages[oauthError] || "An error occurred during sign-in. Please try again.";
  }, [oauthError]);

  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      // Store the session token in a cookie (must match context.ts "session" cookie name)
      document.cookie = `session=${data.sessionToken}; path=/; max-age=${30 * 24 * 60 * 60}; samesite=lax`;

      // Get the redirect URL from query params or default to /all
      const redirectTo = searchParams.get("redirect") ?? "/all";
      router.push(redirectTo);
      router.refresh();
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

  return (
    <div>
      <h2 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        Sign in to your account
      </h2>

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
      <div className="space-y-3">
        <GoogleSignInButton
          label="Sign in with Google"
          onError={(error) => setErrors({ form: error })}
        />
        <AppleSignInButton
          label="Sign in with Apple"
          onError={(error) => setErrors({ form: error })}
        />
      </div>

      {/* Divider */}
      <div className="relative my-6">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-zinc-300 dark:border-zinc-700" />
        </div>
        <div className="ui-text-sm relative flex justify-center">
          <span className="bg-white px-2 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
            Or continue with email
          </span>
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
          disabled={loginMutation.isPending}
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
          disabled={loginMutation.isPending}
        />

        <Button type="submit" className="w-full" loading={loginMutation.isPending}>
          Sign in
        </Button>
      </form>

      {!signupConfigData?.requiresInvite && (
        <p className="ui-text-sm mt-6 text-center text-zinc-600 dark:text-zinc-400">
          Don&apos;t have an account?{" "}
          <Link
            href="/register"
            className="font-medium text-zinc-900 hover:underline dark:text-zinc-50"
          >
            Create one
          </Link>
        </p>
      )}

      <AuthFooter />
    </div>
  );
}
