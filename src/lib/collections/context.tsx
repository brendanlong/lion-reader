/**
 * Collections React Context
 *
 * Provides TanStack DB collections to React components via context.
 * Collections are created once in the TRPCProvider and shared across
 * the component tree.
 *
 * Usage:
 *   const { subscriptions, tags, entries, counts } = useCollections();
 */

"use client";

import { createContext, useContext } from "react";
import type { Collections } from "./index";

const CollectionsContext = createContext<Collections | null>(null);

/**
 * Hook to access TanStack DB collections from any component.
 *
 * @throws Error if used outside of CollectionsProvider
 */
export function useCollections(): Collections {
  const collections = useContext(CollectionsContext);
  if (!collections) {
    throw new Error("useCollections must be used within a CollectionsProvider");
  }
  return collections;
}

export const CollectionsProvider = CollectionsContext.Provider;
