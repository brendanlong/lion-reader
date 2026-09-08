/**
 * App-relative location.
 *
 * The SPA's routing/state layer (`UnifiedEntriesContent`, the sidebar, the URL
 * hooks) is written against app-relative paths — `/all`, `/tag/:id`,
 * `?entry=` — and is mounted at two places: the root for the authenticated app,
 * and `/demo` for the public demo. Components read the location through these
 * hooks instead of `usePathname()`/`useSearchParams()` directly so the same
 * tree works under either mount point:
 *
 * - `useAppPathname()` strips the route base (`/demo/all` → `/all`).
 * - `useRouteBase()` / `useAppHref()` prefix it back onto SPA-relative hrefs
 *   (`ClientLink` does this for every link automatically).
 *
 * `ssrLocation` covers statically prerendered mounts (the demo, issue #1359):
 * at prerender time there is no request, so `useSearchParams()` is empty (the
 * route is `force-static`) and `usePathname()` is the internal route being
 * rendered — for the `?entry=` article URLs that is the rewrite target
 * `/demo/entry/[id]`, not the URL the browser shows. The page knows the
 * location it is being prerendered for and passes it here; the hooks return
 * it during the server render AND the client's hydration render (the two must
 * agree), then hand over to the live URL once hydration has committed.
 */

"use client";

import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useIsHydrated } from "./useIsHydrated";

export interface AppLocation {
  /** App-relative pathname (base already stripped), e.g. "/all". */
  pathname: string;
  /** Query string without the leading "?", e.g. "entry=welcome". */
  search: string;
}

interface AppLocationContextValue {
  basePath: string;
  ssrLocation: AppLocation | null;
}

const AppLocationContext = createContext<AppLocationContextValue>({
  basePath: "",
  ssrLocation: null,
});

interface AppLocationProviderProps {
  /** Route prefix the SPA is mounted under, without a trailing slash (e.g. "/demo"). */
  basePath: string;
  /** The location this render was prerendered for; see the module comment. */
  ssrLocation?: AppLocation;
  children: ReactNode;
}

export function AppLocationProvider({ basePath, ssrLocation, children }: AppLocationProviderProps) {
  const value = useMemo<AppLocationContextValue>(
    () => ({ basePath, ssrLocation: ssrLocation ?? null }),
    [basePath, ssrLocation]
  );
  return createElement(AppLocationContext.Provider, { value }, children);
}

/** Strip the mount prefix from a browser pathname; paths outside it are returned unchanged. */
function stripRouteBase(pathname: string, basePath: string): string {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
}

/** Whether the prerendered location should still be reported (see module comment). */
function useSsrLocation(): AppLocation | null {
  const { ssrLocation } = useContext(AppLocationContext);
  const isHydrated = useIsHydrated();
  return ssrLocation && !isHydrated ? ssrLocation : null;
}

/** The route prefix the SPA is mounted under ("" for the app itself). */
export function useRouteBase(): string {
  return useContext(AppLocationContext).basePath;
}

/** The current pathname relative to the SPA mount point. */
export function useAppPathname(): string {
  const { basePath } = useContext(AppLocationContext);
  const pathname = usePathname();
  const ssrLocation = useSsrLocation();
  return ssrLocation ? ssrLocation.pathname : stripRouteBase(pathname, basePath);
}

/** The current query string as `URLSearchParams`. */
export function useAppSearchParams(): URLSearchParams {
  const searchParams = useSearchParams();
  const ssrLocation = useSsrLocation();
  const ssrSearch = ssrLocation?.search;
  return useMemo(
    () => (ssrSearch === undefined ? searchParams : new URLSearchParams(ssrSearch)),
    [searchParams, ssrSearch]
  );
}

/** Turn a SPA-relative path (with optional query) into the browser href. */
export function useAppHref(): (path: string) => string {
  const basePath = useRouteBase();
  return useMemo(() => (path: string) => `${basePath}${path}`, [basePath]);
}
