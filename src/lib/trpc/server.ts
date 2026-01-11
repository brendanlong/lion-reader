/**
 * tRPC Server-Side Utilities
 *
 * Provides utilities for server-side data prefetching with React Query hydration.
 * Use these in Server Components to prefetch data and hydrate it on the client.
 *
 * @example
 * ```tsx
 * // In a Server Component:
 * import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
 * import { dehydrate } from "@tanstack/react-query";
 *
 * export default async function Page() {
 *   const queryClient = createServerQueryClient();
 *   const { caller } = await createServerCaller();
 *
 *   // Prefetch data
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

import { cache } from "react";
import { cookies } from "next/headers";
import { QueryClient } from "@tanstack/react-query";
import { validateSession, type SessionData } from "@/server/auth";
import { createCaller } from "@/server/trpc";
import { db } from "@/server/db";

/**
 * Creates a QueryClient configured for server-side use.
 *
 * Key differences from client QueryClient:
 * - No retries (server should fail fast)
 * - No refetch on mount (data is fresh from prefetch)
 * - No caching between requests (each request gets fresh data)
 *
 * This should be called once per request, not shared between requests.
 */
export function createServerQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Don't retry on server - fail fast
        retry: false,
        // Don't refetch on mount - data is already fresh from prefetch
        refetchOnMount: false,
        // Data is considered stale immediately on client
        // (client will decide when to refetch based on its own staleTime)
        staleTime: 0,
      },
    },
  });
}

/**
 * Result from createServerCaller
 */
export interface ServerCallerResult {
  /** The tRPC caller for making procedure calls */
  caller: ReturnType<typeof createCaller>;
  /** The validated session, or null if not authenticated */
  session: SessionData | null;
}

/**
 * Creates a tRPC caller with server context.
 *
 * Uses React's cache() to deduplicate the session validation
 * within a single request when called multiple times.
 *
 * @returns The tRPC caller and session data
 *
 * @example
 * ```tsx
 * const { caller, session } = await createServerCaller();
 *
 * if (session) {
 *   // User is authenticated
 *   const entries = await caller.entries.list({ limit: 20 });
 * }
 * ```
 */
export const createServerCaller = cache(async (): Promise<ServerCallerResult> => {
  // Get session token from cookies
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("session")?.value ?? null;

  // Validate session if token exists
  let session: SessionData | null = null;
  if (sessionToken) {
    session = await validateSession(sessionToken);
  }

  // Create the tRPC caller with context
  const caller = createCaller({
    db,
    session,
    apiToken: null,
    authType: session ? "session" : null,
    scopes: [],
    sessionToken,
    headers: new Headers(),
  });

  return { caller, session };
});

/**
 * Helper type for tRPC query keys.
 *
 * tRPC query keys follow the format:
 * [[procedurePath], { input: TInput, type: "query" | "infinite" }]
 *
 * @example
 * ```ts
 * // For trpc.entries.list.useQuery({ limit: 20 })
 * const key: TRPCQueryKey = [["entries", "list"], { input: { limit: 20 }, type: "query" }];
 *
 * // For trpc.entries.list.useInfiniteQuery(...)
 * const key: TRPCQueryKey = [["entries", "list"], { input: { limit: 20 }, type: "infinite" }];
 * ```
 */
export type TRPCQueryKey<TInput = unknown> = [
  /** The procedure path as an array of strings */
  string[],
  /** Query metadata including input and type */
  { input: TInput; type: "query" | "infinite" },
];

/**
 * Creates a tRPC query key for use with React Query.
 *
 * @param path - The procedure path (e.g., ["entries", "list"])
 * @param input - The procedure input
 * @param type - The query type ("query" or "infinite")
 * @returns A properly formatted tRPC query key
 *
 * @example
 * ```ts
 * const key = createQueryKey(["entries", "list"], { limit: 20 });
 * await queryClient.prefetchQuery({
 *   queryKey: key,
 *   queryFn: () => caller.entries.list({ limit: 20 }),
 * });
 * ```
 */
export function createQueryKey<TInput>(
  path: string[],
  input: TInput,
  type: "query" | "infinite" = "query"
): TRPCQueryKey<TInput> {
  return [path, { input, type }];
}
