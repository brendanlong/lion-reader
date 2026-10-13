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
 * To server-render a streamed query's content instead of the skeleton, use
 * `useCanRenderStreamedQuery`.
 *
 * `useSyncExternalStore` is used (rather than useState + useEffect) because
 * React intentionally uses the server snapshot during hydration, guaranteeing
 * the first client render matches the server without a flash of mismatched DOM.
 */

"use client";

import {
  createContext,
  createElement,
  use,
  useContext,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useQueryClient, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";

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

const settledFetches = new WeakMap<Query, Promise<void>>();

/**
 * Resolves once `query` stops fetching, after its result is in the cache.
 * Not `query.promise`: that settles before the query writes its result. One
 * promise per query, so `use()` sees the same one on every retry.
 */
function whenFetchSettles(queryClient: QueryClient, query: Query): Promise<void> {
  let settled = settledFetches.get(query);
  if (!settled) {
    settled = new Promise((resolve) => {
      const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
        if (event.query === query && query.state.fetchStatus !== "fetching") {
          unsubscribe();
          resolve();
        }
      });
    });
    settledFetches.set(query, settled);
  }
  return settled;
}

/**
 * `useCanRenderFromCache` for a query the server prefetched for this request
 * and streamed while pending: before hydration commits, it suspends until that
 * fetch settles, then reports whether the query has data. So the server holds
 * the enclosing `<Suspense>` boundary until the result arrives and streams the
 * real content, and the client hydrates that boundary from the same streamed
 * result (waiting for it if it hasn't landed yet): both sides render the same
 * data. A query the server didn't stream isn't fetching on either side before
 * hydration, so it doesn't suspend and stays gated like `useCanRenderFromCache`.
 *
 * Needs a `<Suspense>` boundary of its own, with the deterministic skeleton as
 * its fallback, rendered by a memoized component whose props don't change on
 * a page load: if anything re-renders the boundary before it has hydrated
 * (say, a parent observing the same query, as the result lands), React throws
 * the server HTML away and client-renders it. It never suspends once
 * hydrated, so later client navigations keep their inline cache-reading
 * fallbacks and never meet the Suspense fallback throttle (see "Suspense vs.
 * inline loading" in src/CLAUDE.md).
 */
export function useCanRenderStreamedQuery(queryKey: QueryKey): boolean {
  const canRenderFromCache = useCanRenderFromCache();
  const queryClient = useQueryClient();
  if (canRenderFromCache) return true;
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) return false;
  if (query.state.fetchStatus === "fetching") use(whenFetchSettles(queryClient, query));
  return query.state.status === "success";
}
