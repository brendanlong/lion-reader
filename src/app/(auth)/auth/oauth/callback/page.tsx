/**
 * OAuth Callback Page
 *
 * Handles the OAuth redirect from providers like Google and Apple.
 * Extracts the authorization code and state from URL,
 * exchanges them for a session (login) or links account (link mode),
 * and redirects to the appropriate page.
 *
 * Link Mode:
 * When oauth_link_mode is set in localStorage, this page links the OAuth
 * account to the currently logged-in user instead of creating a new session.
 */

"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
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
  if (message.includes("already linked")) {
    return "already_linked";
  }
  // Invite-related errors
  if (message.includes("invite is required")) {
    return "invite_required";
  }
  if (message.includes("Invalid invite")) {
    return "invite_invalid";
  }
  if (message.includes("expired")) {
    return "invite_expired";
  }
  if (message.includes("already been used")) {
    return "invite_already_used";
  }
  return "callback_failed";
}

/**
 * Clean up all OAuth-related localStorage items
 */
function cleanupOAuthState() {
  localStorage.removeItem("oauth_state");
  localStorage.removeItem("oauth_link_mode");
  localStorage.removeItem("oauth_link_provider");
}

export default function OAuthCallbackPage() {
  return (
    <Suspense>
      <OAuthCallbackContent />
    </Suspense>
  );
}

function OAuthCallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const hasProcessed = useRef(false);

  // Determine if we're in link mode (linking to existing account)
  // Use lazy initialization to read from localStorage without causing cascading renders
  const [isLinkMode] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("oauth_link_mode") === "true";
    }
    return false;
  });
  const [linkProvider] = useState<"google" | "apple" | null>(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("oauth_link_provider") as "google" | "apple" | null;
    }
    return null;
  });
  // Check if we're in save mode (incrementally adding permissions for Google Docs)
  const [isSaveMode] = useState(() => {
    if (typeof window !== "undefined") {
      return sessionStorage.getItem("pendingSaveUrl") !== null;
    }
    return false;
  });

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

  // Login mutations
  const googleCallbackMutation = trpc.auth.googleCallback.useMutation({
    onSuccess: (data) => {
      // Store the session token in a cookie
      document.cookie = `session=${data.sessionToken}; path=/; max-age=${30 * 24 * 60 * 60}; samesite=lax`;
      cleanupOAuthState();
      router.push("/all");
      router.refresh();
    },
    onError: (error) => {
      cleanupOAuthState();
      const errorCode = getErrorCode(error.message);
      router.push(`/login?error=${errorCode}`);
    },
  });

  const appleCallbackMutation = trpc.auth.appleCallback.useMutation({
    onSuccess: (data) => {
      document.cookie = `session=${data.sessionToken}; path=/; max-age=${30 * 24 * 60 * 60}; samesite=lax`;
      cleanupOAuthState();
      router.push("/all");
      router.refresh();
    },
    onError: (error) => {
      cleanupOAuthState();
      const errorCode = getErrorCode(error.message);
      router.push(`/login?error=${errorCode}`);
    },
  });

  // Link mutations (for linking OAuth to existing account)
  const linkGoogleMutation = trpc.auth.linkGoogle.useMutation({
    onSuccess: () => {
      cleanupOAuthState();
      // If in save mode, redirect back to save page which will retry
      if (isSaveMode) {
        router.push("/save");
      } else {
        router.push("/settings?linked=google");
      }
      router.refresh();
    },
    onError: (error) => {
      cleanupOAuthState();
      const errorCode = getErrorCode(error.message);
      if (isSaveMode) {
        // Clear pending save URL on error
        sessionStorage.removeItem("pendingSaveUrl");
        router.push(`/save?error=${errorCode}`);
      } else {
        router.push(`/settings?link_error=${errorCode}`);
      }
    },
  });

  const linkAppleMutation = trpc.auth.linkApple.useMutation({
    onSuccess: () => {
      cleanupOAuthState();
      router.push("/settings?linked=apple");
      router.refresh();
    },
    onError: (error) => {
      cleanupOAuthState();
      const errorCode = getErrorCode(error.message);
      router.push(`/settings?link_error=${errorCode}`);
    },
  });

  // Effect to process the OAuth callback
  useEffect(() => {
    // Prevent double processing in React Strict Mode
    if (hasProcessed.current) return;

    // Handle validation errors by redirecting
    if (!validation.valid) {
      const redirectPath = isLinkMode
        ? `/settings?link_error=${validation.errorCode}`
        : `/login?error=${validation.errorCode}`;
      cleanupOAuthState();
      const timeoutId = setTimeout(() => {
        router.push(redirectPath);
      }, 2000);
      return () => clearTimeout(timeoutId);
    }

    // Mark as processed to prevent double calls
    hasProcessed.current = true;

    // Determine which mutation to call
    if (isSaveMode) {
      // Save mode: user is adding Google Docs permission (incremental authorization)
      // Always use linkGoogle since user is already logged in
      linkGoogleMutation.mutate({
        code: validation.code,
        state: validation.state,
      });
    } else if (isLinkMode && linkProvider) {
      // Link mode: link OAuth to existing account
      if (linkProvider === "google") {
        linkGoogleMutation.mutate({
          code: validation.code,
          state: validation.state,
        });
      } else if (linkProvider === "apple") {
        linkAppleMutation.mutate({
          code: validation.code,
          state: validation.state,
        });
      }
    } else {
      // Login mode: exchange code for session
      // Default to Google callback (existing behavior)
      // Note: For Apple, the callback comes through a different route (/api/auth/apple/callback)
      googleCallbackMutation.mutate({
        code: validation.code,
        state: validation.state,
      });
    }
  }, [
    validation,
    router,
    isSaveMode,
    isLinkMode,
    linkProvider,
    googleCallbackMutation,
    appleCallbackMutation,
    linkGoogleMutation,
    linkAppleMutation,
  ]);

  // Determine what to display
  const errorMessage = !validation.valid ? validation.error : null;
  const actionText = isSaveMode
    ? "granting permissions"
    : isLinkMode
      ? "linking account"
      : "sign-in";

  return (
    <div className="flex flex-col items-center justify-center">
      <h2 className="mb-6 text-xl font-semibold text-zinc-900 dark:text-zinc-50">
        {errorMessage
          ? isSaveMode
            ? "Permission Error"
            : isLinkMode
              ? "Link Error"
              : "Sign-in Error"
          : `Completing ${actionText}...`}
      </h2>

      {errorMessage ? (
        <div className="text-center">
          <p className="mb-4 text-sm text-red-600 dark:text-red-400">{errorMessage}</p>
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Redirecting to {isSaveMode ? "save" : isLinkMode ? "settings" : "login"} page...
          </p>
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
            Please wait while we complete{" "}
            {isSaveMode
              ? "granting permissions"
              : isLinkMode
                ? "linking your account"
                : "your sign-in"}
            ...
          </p>
        </div>
      )}
    </div>
  );
}
