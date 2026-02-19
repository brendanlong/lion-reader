/**
 * SidebarNav Component
 *
 * Navigation section of the sidebar with streaming unread counts.
 * Each count suspends independently, allowing the nav structure to render immediately.
 */

"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { trpc } from "@/lib/trpc/client";
import { NavLink } from "@/components/ui/nav-link";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

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
 * Suspending component that fetches and displays a single count.
 * Returns null when count is 0 (no badge shown).
 */
function AllItemsCount() {
  const [data] = trpc.entries.count.useSuspenseQuery({});
  return <CountBadge count={data.unread} />;
}

function StarredCount() {
  const [data] = trpc.entries.count.useSuspenseQuery({ starredOnly: true });
  return <CountBadge count={data.unread} />;
}

function SavedCount() {
  const [data] = trpc.entries.count.useSuspenseQuery({ type: "saved" });
  return <CountBadge count={data.unread} />;
}

/**
 * Wraps a count component with ErrorBoundary and Suspense.
 * Shows nothing during loading or on error (graceful degradation).
 */
function SuspenseCount({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/**
 * Main navigation links with independently streaming unread counts.
 */
export function SidebarNav({ onNavigate }: SidebarNavProps) {
  const pathname = usePathname();

  const isActiveLink = (href: string) => pathname === href;

  return (
    <div className="space-y-1 p-3">
      <NavLink
        href="/all"
        isActive={isActiveLink("/all")}
        countElement={
          <SuspenseCount>
            <AllItemsCount />
          </SuspenseCount>
        }
        onClick={onNavigate}
      >
        All Items
      </NavLink>

      <NavLink
        href="/starred"
        isActive={isActiveLink("/starred")}
        countElement={
          <SuspenseCount>
            <StarredCount />
          </SuspenseCount>
        }
        onClick={onNavigate}
      >
        Starred
      </NavLink>

      <NavLink
        href="/saved"
        isActive={isActiveLink("/saved")}
        countElement={
          <SuspenseCount>
            <SavedCount />
          </SuspenseCount>
        }
        onClick={onNavigate}
      >
        Saved
      </NavLink>

      <NavLink href="/recently-read" isActive={isActiveLink("/recently-read")} onClick={onNavigate}>
        Recently Read
      </NavLink>
    </div>
  );
}
