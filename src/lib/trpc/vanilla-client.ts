/**
 * Vanilla tRPC Client Context
 *
 * Provides the vanilla (non-React) tRPC client to components that need
 * to make tRPC calls outside of React hooks — specifically for
 * TanStack DB collection queryFn functions.
 */

"use client";

import { createContext, useContext } from "react";
import type { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "@/server/trpc/root";

export type VanillaClient = ReturnType<typeof createTRPCClient<AppRouter>>;

const VanillaClientContext = createContext<VanillaClient | null>(null);

/**
 * Access the vanilla tRPC client from within components.
 * Must be used inside TRPCProvider.
 */
export function useVanillaClient(): VanillaClient {
  const client = useContext(VanillaClientContext);
  if (!client) {
    throw new Error("useVanillaClient must be used within TRPCProvider");
  }
  return client;
}

export const VanillaClientProvider = VanillaClientContext.Provider;
