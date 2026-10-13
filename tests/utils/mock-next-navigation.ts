/**
 * A reactive `next/navigation` stand-in for component tests:
 *
 *   vi.mock("next/navigation", () => import("../../../utils/mock-next-navigation"));
 *
 * Like the real hooks, `usePathname`/`useSearchParams` re-render every reader
 * when the location changes, memoized subtrees included, so a test navigates
 * with `act(() => setMockLocation(...))` rather than by re-rendering the root.
 */

import { useMemo, useSyncExternalStore } from "react";

let pathname = "/";
let search = "";
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Moves the mocked location; wrap in `act()` while anything is rendered. */
export function setMockLocation(next: { pathname?: string; search?: string }): void {
  pathname = next.pathname ?? pathname;
  search = next.search ?? search;
  for (const listener of listeners) listener();
}

export function getMockPathname(): string {
  return pathname;
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => pathname);
}

export function useSearchParams(): URLSearchParams {
  const current = useSyncExternalStore(subscribe, () => search);
  return useMemo(() => new URLSearchParams(current), [current]);
}
