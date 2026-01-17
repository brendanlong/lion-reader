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
