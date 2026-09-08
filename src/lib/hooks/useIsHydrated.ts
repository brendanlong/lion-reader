/**
 * useIsHydrated Hook
 *
 * Returns `false` during SSR and on the first client render (the hydration
 * pass), then `true` after hydration commits.
 *
 * Use it to gate **cache-dependent** rendering that would otherwise mismatch
 * between the server and client. Our route-specific queries (entries.list,
 * entries.get) are prefetched with `void prefetch(...)` and dehydrated while
 * still pending, so at SSR time the server cache is empty (renders a loading
 * skeleton) but the streamed result lands before client hydration (renders
 * content) — a hydration mismatch for non-suspending `useQuery` consumers.
 * Rendering a deterministic skeleton until `isHydrated` makes the server and
 * the first client render agree; the cache-reading "smart" fallback and the
 * resolved content only render afterward (client-only), so they can't mismatch.
 *
 * `useSyncExternalStore` is used (rather than useState + useEffect) because
 * React intentionally uses the server snapshot during hydration, guaranteeing
 * the first client render matches the server without a flash of mismatched DOM.
 */

"use client";

import {
  createContext,
  createElement,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";

const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function useIsHydrated(): boolean {
  return useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
}

const PrerenderedCacheContext = createContext(false);

/**
 * Declares that the React Query cache holds the same data on the server and on
 * the client's hydration render — the mount seeded it synchronously from fixed
 * data on both sides (the public demo) rather than streaming a prefetch. Under
 * it, `useCanRenderFromCache` is true from the first server render, so the
 * cache-gated components render real content into the prerendered HTML instead
 * of the skeleton described above.
 */
export function PrerenderedCacheProvider({ children }: { children: ReactNode }) {
  return createElement(PrerenderedCacheContext.Provider, { value: true }, children);
}

/**
 * Whether cache-dependent rendering is safe: after hydration, or anywhere the
 * cache is known to be identical on both sides (see PrerenderedCacheProvider).
 */
export function useCanRenderFromCache(): boolean {
  const prerendered = useContext(PrerenderedCacheContext);
  const isHydrated = useIsHydrated();
  return prerendered || isHydrated;
}
