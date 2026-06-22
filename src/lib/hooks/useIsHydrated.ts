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

import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function useIsHydrated(): boolean {
  return useSyncExternalStore(emptySubscribe, getClientSnapshot, getServerSnapshot);
}
