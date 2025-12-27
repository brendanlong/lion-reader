/**
 * tRPC Provider
 *
 * Wraps the application with React Query and tRPC providers.
 * This must be used at the root of the app for tRPC hooks to work.
 */

"use client";

import { useState, useCallback, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./client";

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
 * Clear the session cookie and redirect to login.
 * Uses a flag to prevent multiple redirects from concurrent failed requests.
 */
let isLoggingOut = false;
function handleUnauthorizedError() {
  if (isLoggingOut || typeof window === "undefined") return;
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
  const handleError = useCallback((error: Error) => {
    if (isUnauthorizedError(error)) {
      handleUnauthorizedError();
    }
  }, []);

  const [queryClient] = useState(
    () =>
      new QueryClient({
        queryCache: new QueryCache({
          onError: handleError,
        }),
        mutationCache: new MutationCache({
          onError: handleError,
        }),
        defaultOptions: {
          queries: {
            // With SSR, we usually want to set some default staleTime
            // above 0 to avoid refetching immediately on the client
            staleTime: 60 * 1000, // 1 minute
            // Retry failed requests once, but not for auth errors
            retry: (failureCount, error) => {
              if (isUnauthorizedError(error)) return false;
              return failureCount < 1;
            },
          },
        },
      })
  );

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
