/**
 * Server-side tRPC utilities
 *
 * Provides helpers for calling tRPC procedures from server components
 * and prefetching data for React Query hydration.
 */

import { cookies } from "next/headers";
import { cache } from "react";
import { QueryClient } from "@tanstack/react-query";
import { db } from "@/server/db";
import { validateSession } from "@/server/auth";
import { createCaller } from "@/server/trpc/root";
import type { Context } from "@/server/trpc/context";

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
export const createServerContext = cache(async (): Promise<Context> => {
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
export const createServerCaller = cache(async () => {
  const ctx = await createServerContext();
  return createCaller(ctx);
});

/**
 * Creates a QueryClient for server-side prefetching.
 * Should be created fresh for each request to avoid sharing state.
 */
export function createServerQueryClient(): QueryClient {
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
 * Helper type for prefetch function results.
 * Includes the query client and sync cursor for SSE.
 */
export interface PrefetchResult {
  queryClient: QueryClient;
  /**
   * Server timestamp for SSE sync cursor.
   * Should be captured after all prefetches complete to ensure
   * no events are missed between prefetch and SSE connection.
   */
  initialSyncCursor: string;
}

/**
 * Checks if the current user is authenticated.
 * Useful for conditional prefetching.
 */
export async function isAuthenticated(): Promise<boolean> {
  const ctx = await createServerContext();
  return ctx.session !== null;
}
