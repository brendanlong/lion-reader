/**
 * AuthErrorHandler
 *
 * Watches the React Query cache for auth errors from tRPC calls and reacts:
 * - `UNAUTHORIZED` (session expired/revoked mid-session) → redirect to /login.
 * - `SIGNUP_CONFIRMATION_REQUIRED` → redirect to /complete-signup.
 *
 * This is mounted **only inside the authenticated app SPA** (`(app)/layout.tsx`).
 * That layout's server component has already redirected unauthenticated and
 * unconfirmed users away, so any request the client makes is from a genuinely
 * logged-in user — which is why an `UNAUTHORIZED` here can be treated
 * unconditionally as "the session died, sign out" with no need to inspect a
 * cookie or the failing procedure. Auth pages (`/login`, `/save`, `/demo`, …)
 * deliberately do NOT mount this: their own 401s (a failed login attempt, the
 * bookmarklet's sign-in prompt) are expected and handled locally, so a global
 * redirect there would loop.
 *
 * Renders nothing.
 */

"use client";

import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";

/** Check if an error is a tRPC UNAUTHORIZED error indicating an invalid session. */
function isUnauthorizedError(error: unknown): boolean {
  return error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED";
}

/** Check if an error is a SIGNUP_CONFIRMATION_REQUIRED error. */
function isSignupConfirmationRequired(error: unknown): boolean {
  return (
    error instanceof TRPCClientError && error.data?.appErrorCode === "SIGNUP_CONFIRMATION_REQUIRED"
  );
}

/**
 * Redirect to login. Uses a module-level flag so concurrent failed requests
 * don't each trigger a redirect.
 */
let isLoggingOut = false;
function handleUnauthorizedError() {
  if (isLoggingOut || typeof window === "undefined") return;
  isLoggingOut = true;

  // Redirect to login with the current path as the redirect target. The stale
  // httpOnly session cookie is inert (the server already rejected it) and is
  // overwritten on the next login.
  const currentPath = window.location.pathname + window.location.search;
  const redirectParam =
    currentPath !== "/" && !currentPath.startsWith("/login")
      ? `?redirect=${encodeURIComponent(currentPath)}`
      : "";
  window.location.href = `/login${redirectParam}`;
}

/**
 * Redirect to complete-signup when signup confirmation is required.
 * Uses a flag to prevent multiple redirects from concurrent failed requests.
 */
let isRedirectingToCompleteSignup = false;
function handleSignupConfirmationRequired() {
  if (isRedirectingToCompleteSignup || typeof window === "undefined") return;
  if (window.location.pathname === "/complete-signup") return;

  isRedirectingToCompleteSignup = true;
  window.location.href = "/complete-signup";
}

export function AuthErrorHandler() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const mutationCache = queryClient.getMutationCache();

    const react = (error: unknown) => {
      if (isUnauthorizedError(error)) {
        handleUnauthorizedError();
      } else if (isSignupConfirmationRequired(error)) {
        handleSignupConfirmationRequired();
      }
    };

    const unsubscribeQueries = queryCache.subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        react(event.action.error);
      }
    });
    const unsubscribeMutations = mutationCache.subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        react(event.action.error);
      }
    });

    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient]);

  return null;
}
