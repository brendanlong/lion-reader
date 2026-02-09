/**
 * SidebarNav Component
 *
 * Navigation section of the sidebar with reactive unread counts.
 * Counts are read from the TanStack DB counts collection, which is
 * seeded from SSR-prefetched data and updated by mutations/SSE events.
 */

"use client";

import { useMemo } from "react";
import { usePathname } from "next/navigation";
import { useLiveQuery } from "@tanstack/react-db";
import { useCollections } from "@/lib/collections/context";
import { NavLink } from "@/components/ui/nav-link";

interface SidebarNavProps {
  onNavigate: () => void;
}

/**
 * Styled count badge for nav links. Returns null if count is 0.
 */
function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="ui-text-xs ml-2 shrink-0 text-zinc-500 dark:text-zinc-400">({count})</span>
  );
}

/**
 * Main navigation links with reactive unread counts from the counts collection.
 */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const pathname = usePathname();
  const { counts: countsCollection } = useCollections();
  const { data: allCounts } = useLiveQuery(countsCollection);

  const countMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const record of allCounts) {
      map.set(record.id, record.unread);
    }
    return map;
  }, [allCounts]);

  const isActiveLink = (href: string) => pathname === href;

  return (
    <div className="space-y-1 p-3">
      <NavLink
        href="/all"
        isActive={isActiveLink("/all")}
        countElement={<CountBadge count={countMap.get("all") ?? 0} />}
        onClick={onNavigate}
      >
        All Items
      </NavLink>

      <NavLink
        href="/starred"
        isActive={isActiveLink("/starred")}
        countElement={<CountBadge count={countMap.get("starred") ?? 0} />}
        onClick={onNavigate}
      >
        Starred
      </NavLink>

      <NavLink
        href="/saved"
        isActive={isActiveLink("/saved")}
        countElement={<CountBadge count={countMap.get("saved") ?? 0} />}
        onClick={onNavigate}
      >
        Saved
      </NavLink>
    </div>
  );
}
