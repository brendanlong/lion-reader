/**
 * useEntryListRefreshOnNavigate Hook
 *
 * Central trigger for refreshing entry lists on navigation. Entry list queries
 * use `staleTime: Infinity` and are kept correct in place by mutations and SSE
 * events, so time-based refetching is deliberately disabled. Instead, lists
 * are marked stale when the user navigates to a different list — that's the
 * moment read entries are allowed to disappear from unread-only views.
 *
 * The pathname is exactly the "list identity": the open entry lives in the
 * `?entry=` search param (useEntryUrlState), so moving between a list and an
 * entry in that list — including via browser back/forward — never changes the
 * pathname and never refreshes the list (read entries stay visible under the
 * reader). Navigating to any other page does, regardless of mechanism
 * (sidebar link, entry-view back link, browser history, any ClientLink).
 *
 * Must be mounted in a component that stays mounted across all client-side
 * navigation (AppRouter), not inside a route-specific component: otherwise
 * e.g. /all → /settings → /all would remount the hook and miss the change.
 */

"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

const ENTRIES_LIST_KEY = [["entries", "list"]];

/**
 * Marks all entry list queries stale and refetches the active ones.
 *
 * The single refresh routine shared by the navigation hook and the sidebar's
 * same-route click, so the two sites can't drift:
 *
 * 1. Cancel in-flight fetches on inactive lists (e.g. a fetchNextPage the
 *    user scrolled into just before navigating away). Letting one complete
 *    would clear the staleness flag set below — React Query marks a query
 *    fresh again whenever a fetch succeeds — silently dropping the refresh.
 * 2. Invalidate everything except queries still fetching, which after step 1
 *    can only be the active (arriving/current) list's own request; cancelling
 *    and restarting a request that's already delivering fresh data would just
 *    waste it.
 */
export async function refreshEntryLists(queryClient: QueryClient): Promise<void> {
  await queryClient.cancelQueries({
    queryKey: ENTRIES_LIST_KEY,
    type: "inactive",
    fetchStatus: "fetching",
  });
  await queryClient.invalidateQueries({
    queryKey: ENTRIES_LIST_KEY,
    predicate: (query) => query.state.fetchStatus !== "fetching",
  });
}

export function useEntryListRefreshOnNavigate(): void {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const prevPathnameRef = useRef(pathname);

  useEffect(() => {
    if (prevPathnameRef.current === pathname) return;
    prevPathnameRef.current = pathname;
    void refreshEntryLists(queryClient);
  }, [pathname, queryClient]);
}
