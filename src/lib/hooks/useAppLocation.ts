/**
 * App-relative location.
 *
 * The SPA's routing/state layer is written against app-relative paths (`/all`,
 * `/tag/:id`, `?entry=`) and is mounted at two places: the root for the
 * authenticated app, and `/demo` for the public demo. Components read the
 * location through these hooks instead of `usePathname()`/`useSearchParams()`
 * so the same tree works under either mount point (`useAppPathname()` strips
 * the base; `useAppHref()`/`ClientLink` prefix it back onto hrefs). Hooks that
 * only watch the pathname for *changes* may still use `usePathname()` directly.
 *
 * `ssrLocation` is for statically prerendered mounts, where the URL Next
 * reports during the prerender is not the one the browser will show (the demo
 * serves `?entry=` URLs from an internal route — see the demo layout). While
 * the provider supplies it, the hooks report it instead of the live URL; the
 * mount clears it once hydration has committed and the URL is settled, and it
 * must keep supplying it through the hydration render so server and client
 * output agree.
 */

"use client";

import { createContext, createElement, useContext, useMemo, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";

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
  ssrLocation?: AppLocation | null;
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

/** The prerendered location, while the mount still supplies it (see module comment). */
function useSsrLocation(): AppLocation | null {
  return useContext(AppLocationContext).ssrLocation;
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
