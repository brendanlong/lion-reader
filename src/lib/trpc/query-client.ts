/**
 * Shared QueryClient factory
 *
 * Provides a consistent QueryClient instance within each request/session:
 * - Server: Uses React's cache() to share across server components and client
 *   components during SSR within the same request. This ensures prefetched
 *   data is available to client components during SSR, preventing hydration
 *   mismatches.
 * - Browser: Uses a module-level singleton for the entire session.
 *
 * IMPORTANT: The QueryClient is configured with superjson for serialization
 * during hydration. This matches the tRPC transformer and ensures Date objects
 * and other complex types are properly serialized/deserialized.
 */

import { cache } from "react";
import { QueryClient, defaultShouldDehydrateQuery, isServer } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import superjson from "superjson";

/**
 * Query options for the deploy-static config queries the public pages read
 * (`auth.signupConfig`, `auth.providers`). Their values come from server env and
 * cannot change within a browser session, so we suppress every background
 * refetch: `staleTime: Infinity` keeps the SSR-hydrated data permanently fresh,
 * which alone stops the mount/focus/reconnect refetches (they all only fire on a
 * stale query), and the explicit `refetchOn* : false` flags document that intent
 * and keep it robust if `staleTime` is ever lowered.
 *
 * This is what keeps the signup/sign-in pages from re-hitting `/api/trpc` after
 * hydration — a refetch there previously let a stale shared-cache response
 * overwrite the correct SSR value (the register page's EU-banner flash). The
 * `no-store` header on tRPC responses stops shared caches from storing them in
 * the first place; this stops the client from asking at all.
 */
export const STATIC_CONFIG_QUERY_OPTIONS = {
  staleTime: Infinity,
  refetchOnMount: false,
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
} as const;

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
 * Configured with superjson for hydration to match tRPC's transformer.
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
      // Configure hydration to use superjson (matches tRPC transformer)
      dehydrate: {
        serializeData: superjson.serialize,
        // Include pending queries in dehydration so they can be streamed to client
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
      hydrate: {
        deserializeData: superjson.deserialize,
      },
    },
  });
}

/**
 * Creates a new QueryClient for the browser.
 * Includes retry logic for resilience, but skips retrying auth errors.
 * Configured with superjson for hydration to match tRPC's transformer.
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
      // Configure hydration to use superjson (matches tRPC transformer)
      dehydrate: {
        serializeData: superjson.serialize,
        // Include pending queries in dehydration so they can be streamed to client
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === "pending",
      },
      hydrate: {
        deserializeData: superjson.deserialize,
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
