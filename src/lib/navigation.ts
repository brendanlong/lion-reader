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
