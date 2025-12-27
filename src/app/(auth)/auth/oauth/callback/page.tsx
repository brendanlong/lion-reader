/**
 * OAuth Callback Page
 *
 * Handles the OAuth redirect from providers like Google.
 * Extracts the authorization code and state from URL,
 * exchanges them for a session, and redirects to the app.
 */

"use client";

import { useEffect, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc/client";

/**
 * Validation result for OAuth callback parameters
 */
type CallbackValidation =
  | { valid: true; code: string; state: string }
  | { valid: false; error: string; errorCode: string };

/**
 * Helper to map error messages to error codes for redirect
 */
function getErrorCode(message: string): string {
  if (message.includes("state") || message.includes("State")) {
    return "invalid_state";
  }
  if (message.includes("not configured") || message.includes("not available")) {
    return "provider_not_configured";
  }
  return "callback_failed";
}

export default function OAuthCallbackPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasProcessed = useRef(false);

  // Validate callback parameters upfront (no effect needed for validation)
  const validation = useMemo((): CallbackValidation => {
    const code = searchParams.get("code");
    const stateFromUrl = searchParams.get("state");

    // Note: localStorage is only available on client, so this check happens
    // after hydration. We'll handle the case where it's not available.
    let storedState: string | null = null;
    if (typeof window !== "undefined") {
      storedState = localStorage.getItem("oauth_state");
    }

    if (!code) {
      return {
        valid: false,
        error: "Authorization code not received",
        errorCode: "callback_failed",
      };
    }

    if (!stateFromUrl) {
      return {
        valid: false,
        error: "State parameter not received",
        errorCode: "callback_failed",
      };
    }

    // For SSR safety, we'll validate state on client only
    if (typeof window !== "undefined" && stateFromUrl !== storedState) {
      return {
        valid: false,
        error: "Security verification failed. Please try again.",
        errorCode: "invalid_state",
      };
    }

    return { valid: true, code, state: stateFromUrl };
  }, [searchParams]);

  const googleCallbackMutation = trpc.auth.googleCallback.useMutation({
    onSuccess: (data) => {
      // Store the session token in a cookie
      document.cookie = `session=${data.sessionToken}; path=/; max-age=${30 * 24 * 60 * 60}; samesite=lax`;

      // Clean up OAuth state from localStorage
      localStorage.removeItem("oauth_state");

      // Redirect to the app
      router.push("/all");
      router.refresh();
    },
    onError: (error) => {
      // Clean up OAuth state
      localStorage.removeItem("oauth_state");

      // Redirect to login with error
      const errorCode = getErrorCode(error.message);
      router.push(`/login?error=${errorCode}`);
    },
  });

  // Effect to process the OAuth callback
  useEffect(() => {
    // Prevent double processing in React Strict Mode
    if (hasProcessed.current) return;

    // Handle validation errors by redirecting
    if (!validation.valid) {
      localStorage.removeItem("oauth_state");
      const timeoutId = setTimeout(() => {
        router.push(`/login?error=${validation.errorCode}`);
      }, 2000);
      return () => clearTimeout(timeoutId);
    }

    // Mark as processed to prevent double calls
    hasProcessed.current = true;

    // Exchange code for session
    googleCallbackMutation.mutate({
      code: validation.code,
      state: validation.state,
    });
  }, [validation, router, googleCallbackMutation]);

  // Determine what to display
  const errorMessage = !validation.valid ? validation.error : null;

  return (
    <div className="flex flex-col items-center justify-center">
      <h2 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {errorMessage ? "Sign-in Error" : "Completing sign-in..."}
      </h2>

      {errorMessage ? (
        <div className="text-center">
          <p className="mb-4 text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">Redirecting to login page...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4">
          <svg
            className="h-8 w-8 animate-spin text-zinc-900 dark:text-zinc-100"
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
          >
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Please wait while we complete your sign-in...
          </p>
        </div>
      )}
    </div>
  );
}
