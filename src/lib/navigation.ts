/**
 * Client-side navigation utilities
 *
 * Uses the History API directly to navigate without triggering SSR.
 */

import { type MouseEvent } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

/** Route prefixes that render as their own document *outside* the app SPA shell. */
const NON_SPA_PREFIXES = [
  "/login",
  "/register",
  "/complete-signup",
  "/privacy",
  "/terms",
  "/auth",
] as const;

/**
 * True when `path` is rendered inside the main app SPA shell (so a client-side
 * soft navigation is safe), false for a standalone route that needs a full load.
 */
export function isSpaPath(path: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0];
  return !NON_SPA_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}

/**
 * Navigate to a post-auth destination: a soft-nav for SPA routes, a full page
 * load for standalone routes.
 *
 * Standalone routes outside the SPA shell — the auth pages (`/login`,
 * `/register`, `/complete-signup`, the OAuth pages) and the public legal pages
 * (`/privacy`, `/terms`) — are served as their own HTML documents. They must be
 * *entered* via a real browser navigation, never a Next.js RSC soft-nav
 * (`router.push`): a soft-nav issues an `?_rsc=` request that can hit a newer
 * server build than the (possibly CDN-cached) shell that started it, producing a
 * version-skew error. Clickable links to these routes already avoid soft-nav by
 * using `PageLink` (a plain `<a>`); this is the programmatic (post-mutation
 * redirect) counterpart. See `src/CLAUDE.md`.
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
