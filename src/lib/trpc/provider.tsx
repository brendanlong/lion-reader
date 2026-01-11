/**
 * tRPC Provider
 *
 * Wraps the application with React Query and tRPC providers.
 * This must be used at the root of the app for tRPC hooks to work.
 */

"use client";

import { useState, useCallback, type ReactNode } from "react";
import {
  QueryClient,
  QueryClientProvider,
  QueryCache,
  MutationCache,
  HydrationBoundary,
  dehydrate,
  type DehydratedState,
} from "@tanstack/react-query";
import { QueryNormalizerProvider } from "@normy/react-query";
import { httpBatchLink } from "@trpc/client";
import { TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./client";

// Re-export for use in server components
export { HydrationBoundary, dehydrate };

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
  /**
   * Dehydrated state from server-side prefetching.
   * When provided, the prefetched data will be hydrated into the QueryClient.
   *
   * @example
   * ```tsx
   * // In a Server Component:
   * import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
   * import { dehydrate } from "@/lib/trpc/provider";
   *
   * export default async function Page() {
   *   const queryClient = createServerQueryClient();
   *   const { caller } = await createServerCaller();
   *
   *   await queryClient.prefetchQuery({
   *     queryKey: [["entries", "list"], { input: { limit: 20 }, type: "query" }],
   *     queryFn: () => caller.entries.list({ limit: 20 }),
   *   });
   *
   *   return (
   *     <TRPCProvider dehydratedState={dehydrate(queryClient)}>
   *       <ClientComponent />
   *     </TRPCProvider>
   *   );
   * }
   * ```
   */
  dehydratedState?: DehydratedState;
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
export function TRPCProvider({ children, dehydratedState }: TRPCProviderProps) {
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
      <QueryNormalizerProvider queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <HydrationBoundary state={dehydratedState}>{children}</HydrationBoundary>
        </QueryClientProvider>
      </QueryNormalizerProvider>
    </trpc.Provider>
  );
}
