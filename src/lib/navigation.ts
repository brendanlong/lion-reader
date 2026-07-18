/**
 * Client-side navigation utilities
 *
 * Uses the History API directly to navigate without triggering SSR.
 */

import { type MouseEvent } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

/**
 * Route prefixes for the public, unauthenticated pages whose HTML a CDN can
 * cache. A soft-nav into one of these risks a version-skew error, so they need a
 * full page load. Authenticated routes (the app SPA, `/complete-signup`) are
 * never cached and are deliberately absent.
 */
const CACHEABLE_PUBLIC_PREFIXES = ["/login", "/register", "/privacy", "/terms", "/auth"] as const;

/**
 * True when a client-side soft navigation to `path` is safe — i.e. it is NOT a
 * CDN-cacheable public page. Both the in-app SPA routes and authenticated
 * standalone routes like `/complete-signup` (never cached) return true.
 */
export function isSpaPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  return !CACHEABLE_PUBLIC_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Navigate to a post-auth destination: a soft-nav for SPA routes, a full page
 * load for the CDN-cacheable public pages.
 *
 * The public, unauthenticated entry pages — the auth pages (`/login`,
 * `/register`, the OAuth pages) and the public legal pages (`/privacy`,
 * `/terms`) — are served without a session cookie, so a CDN can cache their
 * HTML. They must be *entered* via a real browser navigation, never a Next.js
 * RSC soft-nav (`router.push`): a soft-nav issues an `?_rsc=` request that can
 * hit a newer server build than the (possibly cached) shell that started it,
 * producing a version-skew error. Clickable links to these routes already avoid
 * soft-nav by using `PageLink` (a plain `<a>`); this is the programmatic
 * (post-mutation redirect) counterpart. See `src/CLAUDE.md`.
 *
 * Authenticated standalone routes (e.g. `/complete-signup`, whose layout
 * redirects logged-out users to `/login`) are never served cookie-less, so
 * they're never cached and a soft-nav to them is safe — they're intentionally
 * treated as SPA paths here.
 *
 * Pass the same path you'd give `router.push`. The SPA branch also
 * `router.refresh()`es so the authenticated shell re-renders server-side with
 * the new session.
 */
export function navigateAfterAuth(
  router: Pick<AppRouterInstance, "push" | "refresh">,
  path: string
): void {
  if (isSpaPath(path)) {
    router.push(path);
    router.refresh();
  } else {
    window.location.href = path;
  }
}

/**
 * Navigate using pushState without triggering SSR.
 * UnifiedEntriesContent reads usePathname() to determine what to render.
 */
export function clientPush(href: string): void {
  window.history.pushState(null, "", href);
}

/**
 * Navigate using replaceState without triggering SSR.
 * UnifiedEntriesContent reads usePathname() to determine what to render.
 */
export function clientReplace(href: string): void {
  window.history.replaceState(null, "", href);
}

/**
 * Extract dynamic route params from a pathname.
 *
 * Shallow routing skips Next's route-tree reconciliation, so useParams()
 * doesn't update on pushState; params must be parsed from the pathname instead.
 *
 * @param basePath - Route prefix to strip before matching (e.g. "/demo").
 *                   If the pathname doesn't start with it, no params match.
 */
export function extractParamsFromPathname(
  pathname: string,
  basePath = ""
): { subscriptionId?: string; tagId?: string } {
  let path = pathname;
  if (basePath) {
    if (!pathname.startsWith(basePath)) return {};
    path = pathname.slice(basePath.length);
  }

  // /subscription/:id
  const subscriptionMatch = path.match(/^\/subscription\/([^/]+)/);
  if (subscriptionMatch) {
    return { subscriptionId: subscriptionMatch[1] };
  }

  // /tag/:tagId
  const tagMatch = path.match(/^\/tag\/([^/]+)/);
  if (tagMatch) {
    return { tagId: tagMatch[1] };
  }

  return {};
}

/**
 * Click handler for client-side navigation without SSR.
 *
 * Falls through to the browser's default handling (no preventDefault) for any
 * click the browser would treat specially, so we don't hijack:
 * - modifier clicks (cmd/ctrl/shift/alt → new tab / new window / download),
 * - non-primary mouse buttons (middle-click → new tab),
 * - anchors with an explicit `target` (e.g. `_blank`) or `download` attribute.
 *
 * @example
 * ```tsx
 * <Link href="/all" onClick={(e) => handleClientNav(e, "/all")}>
 *   All Items
 * </Link>
 * ```
 */
export function handleClientNav(
  e: MouseEvent<HTMLAnchorElement>,
  href: string,
  callback?: () => void
): void {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;

  // Respect anchors that intentionally open elsewhere or download.
  const target = e.currentTarget.getAttribute("target");
  if ((target && target !== "_self") || e.currentTarget.hasAttribute("download")) return;

  e.preventDefault();
  clientPush(href);
  callback?.();
}
