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
import { useQueryClient } from "@tanstack/react-query";

export function useEntryListRefreshOnNavigate(): void {
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const prevPathnameRef = useRef(pathname);

  useEffect(() => {
    if (prevPathnameRef.current === pathname) return;
    prevPathnameRef.current = pathname;

    // Mark all entry list queries stale; active ones refetch now, inactive
    // ones refetch on next mount. Skip queries that are already fetching
    // (e.g. the just-mounted query for the arriving route, which is loading
    // or was marked stale by a previous navigation and is refetching) —
    // invalidating those would cancel and restart their in-flight request.
    queryClient.invalidateQueries({
      queryKey: [["entries", "list"]],
      predicate: (query) => query.state.fetchStatus !== "fetching",
    });
  }, [pathname, queryClient]);
}
