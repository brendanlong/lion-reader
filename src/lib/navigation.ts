/**
 * Client-side navigation utilities
 *
 * Uses the History API directly to navigate without triggering SSR.
 */

import { type MouseEvent } from "react";

/** Serializable state stored on a history entry. */
export type HistoryState = Record<string, unknown>;

/**
 * Next's patched pushState/replaceState write their internal keys (`__NA`,
 * `__PRIVATE_NEXTJS_INTERNALS_TREE`) *into the object we pass* rather than
 * copying it, and then treat any object that already carries `__NA` as one of
 * their own internal calls — updating the URL but skipping the router sync that
 * makes `usePathname`/`useSearchParams` see it. Handing the same object over
 * twice therefore makes the second navigation a silent no-op, so every call
 * gets a fresh copy.
 */
function freshHistoryState(state: HistoryState | null): HistoryState | null {
  return state === null ? null : { ...state };
}

/**
 * Navigate using pushState without triggering SSR.
 * UnifiedEntriesContent reads usePathname() to determine what to render.
 *
 * `state` is stored on the created history entry, so a later handler can tell
 * which entry it created (see `useEntryUrlState`).
 */
export function clientPush(href: string, state: HistoryState | null = null): void {
  window.history.pushState(freshHistoryState(state), "", href);
}

/**
 * Navigate using replaceState without triggering SSR.
 * UnifiedEntriesContent reads usePathname() to determine what to render.
 *
 * Note that replacing overwrites the current entry's state, so callers that
 * need to keep a marker set by `clientPush` must pass it through again.
 */
export function clientReplace(href: string, state: HistoryState | null = null): void {
  window.history.replaceState(freshHistoryState(state), "", href);
}

/**
 * Extract dynamic route params from an app-relative pathname.
 *
 * Shallow routing skips Next's route-tree reconciliation, so useParams()
 * doesn't update on pushState; params must be parsed from the pathname instead.
 */
export function extractParamsFromPathname(pathname: string): {
  subscriptionId?: string;
  tagId?: string;
} {
  // /subscription/:id
  const subscriptionMatch = pathname.match(/^\/subscription\/([^/]+)/);
  if (subscriptionMatch) {
    return { subscriptionId: subscriptionMatch[1] };
  }

  // /tag/:tagId
  const tagMatch = pathname.match(/^\/tag\/([^/]+)/);
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
