/**
 * tRPC Provider
 *
 * Wraps the application with React Query and tRPC providers.
 * This must be used at the root of the app for tRPC hooks to work.
 */

"use client";

import { useState, useEffect, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./client";
import { getQueryClient } from "./query-client";

/**
 * Check if an error is a tRPC UNAUTHORIZED error indicating invalid session.
 */
function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof TRPCClientError) {
    // Check for UNAUTHORIZED tRPC code
    return error.data?.code === "UNAUTHORIZED";
  }
  return false;
}

/**
 * Check if an error is a SIGNUP_CONFIRMATION_REQUIRED error.
 */
function isSignupConfirmationRequired(error: unknown): boolean {
  if (error instanceof TRPCClientError) {
    return error.data?.appErrorCode === "SIGNUP_CONFIRMATION_REQUIRED";
  }
  return false;
}

/**
 * Check if the user currently has a session cookie.
 */
function hasSessionCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((c) => c.trim().startsWith("session="));
}

/**
 * Clear the session cookie and redirect to login.
 * Uses a flag to prevent multiple redirects from concurrent failed requests.
 * Only triggers if the user is currently logged in (has a session cookie).
 */
let isLoggingOut = false;
function handleUnauthorizedError() {
  if (isLoggingOut || typeof window === "undefined") return;

  // Only sign out if the user is currently logged in
  // This prevents login errors from causing a redirect/refresh
  if (!hasSessionCookie()) return;

  // Skip auto-redirect for /save page - it has its own auth error handling
  // that provides a better UX for the bookmarklet popup
  if (window.location.pathname === "/save") return;

  isLoggingOut = true;

  // Clear the session cookie
  document.cookie = "session=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT";

  // Redirect to login with current path as redirect target
  const currentPath = window.location.pathname + window.location.search;
  const redirectParam =
    currentPath !== "/" && !currentPath.startsWith("/login")
      ? `?redirect=${encodeURIComponent(currentPath)}`
      : "";
  window.location.href = `/login${redirectParam}`;
}

/**
 * Redirect to complete-signup page when signup confirmation is required.
 * Uses a flag to prevent multiple redirects from concurrent failed requests.
 */
let isRedirectingToCompleteSignup = false;
function handleSignupConfirmationRequired() {
  if (isRedirectingToCompleteSignup || typeof window === "undefined") return;

  // Already on the complete-signup page
  if (window.location.pathname === "/complete-signup") return;

  isRedirectingToCompleteSignup = true;
  window.location.href = "/complete-signup";
}

/**
 * Get the base URL for API requests.
 * Uses window.location in browser, empty string on server.
 */
function getBaseUrl() {
  if (typeof window !== "undefined") {
    // Browser: use relative URL
    return "";
  }
  // SSR: use localhost
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

interface TRPCProviderProps {
  children: ReactNode;
}

/**
 * TRPC Provider component.
 * Wrap your app with this to enable tRPC hooks.
 *
 * @example
 * ```tsx
 * // In your root layout:
 * <TRPCProvider>
 *   {children}
 * </TRPCProvider>
 * ```
 */
export function TRPCProvider({ children }: TRPCProviderProps) {
  // Use the shared QueryClient from query-client.ts
  // This ensures server prefetching and client components use the same instance
  // during SSR, preventing hydration mismatches.
  const queryClient = getQueryClient();

  // Set up error handling via cache subscription (client-side only)
  // This handles unauthorized errors by clearing the session and redirecting
  useEffect(() => {
    const queryCache = queryClient.getQueryCache();
    const mutationCache = queryClient.getMutationCache();

    // Subscribe to query cache events to catch errors
    const unsubscribeQueries = queryCache.subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        const error = event.action.error;
        if (isUnauthorizedError(error)) {
          handleUnauthorizedError();
        } else if (isSignupConfirmationRequired(error)) {
          handleSignupConfirmationRequired();
        }
      }
    });

    // Subscribe to mutation cache events to catch errors
    const unsubscribeMutations = mutationCache.subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        const error = event.action.error;
        if (isUnauthorizedError(error)) {
          handleUnauthorizedError();
        } else if (isSignupConfirmationRequired(error)) {
          handleSignupConfirmationRequired();
        }
      }
    });

    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient]);

  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: `${getBaseUrl()}/api/trpc`,
          transformer: superjson,
          // Include credentials for cookie-based auth
          fetch(url, options) {
            return fetch(url, {
              ...options,
              credentials: "include",
            });
          },
        }),
      ],
    })
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
