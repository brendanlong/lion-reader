/**
 * Shared QueryClient factory
 *
 * Provides a consistent QueryClient instance within each request/session:
 * - Server: Uses React's cache() to share across server components and client
 *   components during SSR within the same request. This ensures prefetched
 *   data is available to client components during SSR, preventing hydration
 *   mismatches.
 * - Browser: Uses a module-level singleton for the entire session.
 */

import { cache } from "react";
import { QueryClient, isServer } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";

/**
 * Check if an error is a tRPC UNAUTHORIZED error indicating invalid session.
 */
function isUnauthorizedError(error: unknown): boolean {
  if (error instanceof TRPCClientError) {
    return error.data?.code === "UNAUTHORIZED";
  }
  return false;
}

/**
 * Creates a new QueryClient for server-side rendering.
 * Optimized for prefetching: no retries, errors propagate immediately.
 */
function makeServerQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Don't retry on server - let errors propagate
        retry: false,
        // Prevent refetching on client mount - we're prefetching for hydration
        staleTime: 60 * 1000,
      },
    },
  });
}

/**
 * Creates a new QueryClient for the browser.
 * Includes retry logic for resilience, but skips retrying auth errors.
 */
function makeBrowserQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Retry failed requests once, but not for auth errors
        retry: (failureCount, error) => {
          if (isUnauthorizedError(error)) return false;
          return failureCount < 1;
        },
        // Prevent refetching on mount - we're hydrating from SSR
        staleTime: 60 * 1000,
      },
    },
  });
}

/**
 * Server-side: cached QueryClient per request.
 * React's cache() ensures the same instance is returned for all calls
 * within a single request (including server components and client components
 * running on the server during SSR).
 */
const getServerQueryClient = cache(makeServerQueryClient);

/**
 * Browser-side: module-level singleton.
 * Persists for the entire browser session.
 */
let browserQueryClient: QueryClient | undefined;

/**
 * Returns the QueryClient for the current environment.
 *
 * - Server (during SSR): Returns a request-scoped cached instance
 * - Browser: Returns a persistent singleton
 *
 * This function should be used both for server-side prefetching and
 * in the TRPCProvider to ensure hydration consistency.
 */
export function getQueryClient(): QueryClient {
  if (isServer) {
    return getServerQueryClient();
  }

  // Browser: create singleton on first call
  if (!browserQueryClient) {
    browserQueryClient = makeBrowserQueryClient();
  }
  return browserQueryClient;
}
