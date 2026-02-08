/**
 * Server-side tRPC utilities
 *
 * Provides helpers for calling tRPC procedures from server components
 * and prefetching data for React Query hydration.
 */

import { cookies } from "next/headers";
import { cache } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { createHydrationHelpers } from "@trpc/react-query/rsc";
import { db } from "@/server/db";
import { validateSession } from "@/server/auth/session";
import { createCaller, type AppRouter } from "@/server/trpc/root";
import type { Context } from "@/server/trpc/context";
import { getQueryClient } from "./query-client";

/**
 * Gets the session token from cookies.
 * Uses Next.js cookies() API which works in server components.
 */
async function getSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get("session")?.value ?? null;
}

/**
 * Creates a server-side tRPC context with session from cookies.
 * Cached per request to avoid redundant session validation.
 */
const createServerContext = cache(async (): Promise<Context> => {
  const sessionToken = await getSessionToken();

  if (!sessionToken) {
    return {
      db,
      session: null,
      apiToken: null,
      authType: null,
      scopes: [],
      sessionToken: null,
      headers: new Headers(),
    };
  }

  const session = await validateSession(sessionToken);

  if (!session) {
    return {
      db,
      session: null,
      apiToken: null,
      authType: null,
      scopes: [],
      sessionToken: null,
      headers: new Headers(),
    };
  }

  return {
    db,
    session,
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken,
    headers: new Headers(),
  };
});

/**
 * Creates a server-side tRPC caller.
 * Uses the session from cookies for authentication.
 * Cached per request.
 */
const createServerCaller = cache(async () => {
  const ctx = await createServerContext();
  return createCaller(ctx);
});

/**
 * Creates tRPC hydration helpers for RSC prefetching.
 *
 * Returns:
 * - `trpc`: Wrapped caller with prefetch helpers
 *   - Direct calls: `await trpc.entries.list({...})`
 *   - Prefetching: `void trpc.entries.list.prefetch({...})`
 *   - Infinite prefetching: `void trpc.entries.list.prefetchInfinite({...})`
 * - `HydrateClient`: Component that dehydrates the QueryClient and provides
 *   it to client components. Wrap your client components with this.
 *
 * Prefetch methods automatically use the correct query key format,
 * ensuring cache hits when client components query the same data.
 *
 * @example
 * ```tsx
 * const { trpc, HydrateClient } = await createHydrationHelpersForRequest();
 * void trpc.entries.list.prefetch({});
 * return <HydrateClient>{children}</HydrateClient>;
 * ```
 */
export const createHydrationHelpersForRequest = cache(async () => {
  const caller = await createServerCaller();
  return createHydrationHelpers<AppRouter>(caller, getQueryClient);
});

/**
 * Helper type for prefetch function results.
 * Includes the query client and sync cursor for SSE.
 */
export interface PrefetchResult {
  queryClient: QueryClient;
  /**
   * Initial sync cursors for each entity type.
   * Null values indicate an initial sync that will fetch all recent data
   * and establish baseline cursors for subsequent incremental syncs.
   */
  initialCursors: {
    entries: string | null;
    entryStates: string | null;
    subscriptions: string | null;
    removedSubscriptions: string | null;
    tags: string | null;
  };
}

/**
 * Checks if the current user is authenticated.
 * Useful for conditional prefetching.
 */
export async function isAuthenticated(): Promise<boolean> {
  const ctx = await createServerContext();
  return ctx.session !== null;
}
