/**
 * tRPC Provider
 *
 * Wraps the application with React Query and tRPC providers.
 * Also initializes TanStack DB collections for normalized client-side state.
 * This must be used at the root of the app for tRPC hooks to work.
 */

"use client";

import { useState, useEffect, type ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createTRPCClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "./client";
import { getQueryClient } from "./query-client";
import type { AppRouter } from "@/server/trpc/root";
import { createCollections } from "@/lib/collections";
import { CollectionsProvider } from "@/lib/collections/context";
import { VanillaClientProvider, type VanillaClient } from "./vanilla-client";

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
 * Creates the shared httpBatchLink configuration.
 * Used by both the React tRPC client and the vanilla tRPC client.
 */
function createBatchLink() {
  return httpBatchLink({
    url: `${getBaseUrl()}/api/trpc`,
    transformer: superjson,
    // Include credentials for cookie-based auth
    fetch(url, options) {
      return fetch(url, {
        ...options,
        credentials: "include",
      });
    },
  });
}

/**
 * TRPC Provider component.
 * Wrap your app with this to enable tRPC hooks.
 * Also initializes TanStack DB collections for normalized client-side state.
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
        }
      }
    });

    // Subscribe to mutation cache events to catch errors
    const unsubscribeMutations = mutationCache.subscribe((event) => {
      if (event.type === "updated" && event.action.type === "error") {
        const error = event.action.error;
        if (isUnauthorizedError(error)) {
          handleUnauthorizedError();
        }
      }
    });

    return () => {
      unsubscribeQueries();
      unsubscribeMutations();
    };
  }, [queryClient]);

  // Create the React tRPC client (for hooks)
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [createBatchLink()],
    })
  );

  // Create a vanilla tRPC client (for collection queryFn calls)
  // Exposed via VanillaClientProvider for use by on-demand collection hooks
  const [vanillaClient] = useState<VanillaClient>(() =>
    createTRPCClient<AppRouter>({
      links: [createBatchLink()],
    })
  );

  // Initialize TanStack DB collections and query cache subscription.
  // Both are stored together so the cleanup function is accessible for teardown.
  // Entry counts and uncategorized counts are seeded from prefetched data and
  // kept in sync via query cache subscriptions inside createCollections.
  const [{ collections, cleanup: collectionsCleanup }] = useState(() =>
    createCollections(queryClient, {
      fetchTagsAndUncategorized: () => vanillaClient.tags.list.query(),
    })
  );

  // Clean up the query cache subscription when the provider unmounts
  useEffect(() => {
    return () => {
      collectionsCleanup();
    };
  }, [collectionsCleanup]);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <VanillaClientProvider value={vanillaClient}>
          <CollectionsProvider value={collections}>{children}</CollectionsProvider>
        </VanillaClientProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
