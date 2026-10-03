/**
 * Client-side navigation utilities
 *
 * Uses the History API directly to navigate without triggering SSR.
 */

import { type MouseEvent } from "react";

/** Serializable state stored on a history entry. */
type HistoryState = Record<string, unknown>;

/**
 * Next's patched pushState/replaceState carry their internal keys (`__NA`,
 * `__PRIVATE_NEXTJS_INTERNALS_TREE`) forward from the current history entry by
 * writing them *into the object we pass* rather than copying it, and then treat
 * any object that already carries `__NA` as one of their own internal calls —
 * updating the URL but skipping the router sync that makes
 * `usePathname`/`useSearchParams` see it. Handing the same object over twice
 * therefore makes the second navigation a silent no-op, so every call gets a
 * fresh copy.
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

/** App-relative pathnames of the entry-list views without a dynamic segment. */
const STATIC_ENTRY_LIST_PATHNAMES = new Set([
  "/all",
  "/starred",
  "/saved",
  "/uncategorized",
  "/recently-read",
]);

function isEntryListPathname(pathname: string): boolean {
  if (STATIC_ENTRY_LIST_PATHNAMES.has(pathname)) return true;
  const { subscriptionId, tagId } = extractParamsFromPathname(pathname);
  return subscriptionId !== undefined || tagId !== undefined;
}

/**
 * Whether a click on `anchor` is one the browser would treat as a plain
 * same-tab navigation. Anything else falls through to the browser so we don't
 * hijack:
 * - modifier clicks (cmd/ctrl/shift/alt → new tab / new window / download),
 * - non-primary mouse buttons (middle-click → new tab),
 * - anchors with an explicit `target` (e.g. `_blank`) or `download` attribute.
 */
function isPlainNavigationClick(e: MouseEvent, anchor: Element): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return false;
  const target = anchor.getAttribute("target");
  return !(target && target !== "_self") && !anchor.hasAttribute("download");
}

/**
 * Click handler for client-side navigation without SSR. Clicks the browser
 * would treat specially are left alone (see `isPlainNavigationClick`).
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
  if (!isPlainNavigationClick(e, e.currentTarget)) return;

  e.preventDefault();
  clientPush(href);
  callback?.();
}

/**
 * Click handler for a container of rendered HTML (article content): a plain
 * click on a link to an entry-list view inside the SPA mount at `basePath`
 * becomes a `pushState` navigation instead of a full page load.
 *
 * Every other link is left to the browser: other origins, routes outside the
 * mount (standalone pages like `/login`, which aren't part of the SPA), and
 * links that change only the hash (in-page anchors such as footnotes).
 */
export function handleContentLinkClick(e: MouseEvent, basePath: string): void {
  if (e.defaultPrevented || !(e.target instanceof Element)) return;
  const anchor = e.target.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement) || !isPlainNavigationClick(e, anchor)) return;

  const url = new URL(anchor.href);
  const current = window.location;
  if (url.origin !== current.origin) return;
  if (url.hash && url.pathname === current.pathname && url.search === current.search) return;

  if (!url.pathname.startsWith(`${basePath}/`)) return;
  if (!isEntryListPathname(url.pathname.slice(basePath.length))) return;

  e.preventDefault();
  clientPush(`${url.pathname}${url.search}${url.hash}`);
}
