/**
 * Client-side navigation utilities
 *
 * Uses the History API directly to navigate without triggering SSR.
 */

import { type MouseEvent } from "react";

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
 * Allows cmd/ctrl+click to open in new tab.
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
  // Allow cmd/ctrl+click for new tab
  if (e.metaKey || e.ctrlKey) return;
  e.preventDefault();
  clientPush(href);
  callback?.();
}
