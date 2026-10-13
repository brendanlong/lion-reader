/**
 * tRPC React Client
 *
 * This module sets up the tRPC client for use in React components.
 * It provides type-safe hooks for calling tRPC procedures.
 */

"use client";

import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/trpc/root";

/**
 * tRPC React hooks.
 * Use these in client components:
 *
 * @example
 * ```tsx
 * const { data } = trpc.entries.list.useQuery({ limit: 20 });
 * const mutation = trpc.entries.markRead.useMutation();
 * ```
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Type for tRPC utils returned by trpc.useUtils().
 * Used by cache helper functions.
 */
export type TRPCClientUtils = ReturnType<typeof trpc.useUtils>;

/**
 * Query options that send the request on its own instead of in the shared
 * batch. A batch responds only when its slowest call finishes, so use this
 * for speculative fetches (prefetching neighbours) that must not hold up a
 * request the user is waiting on.
 */
export const UNBATCHED = { trpc: { context: { skipBatch: true } } } as const;
