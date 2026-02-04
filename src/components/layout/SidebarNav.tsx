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
import { NavLink } from "@/components/ui";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

interface SidebarNavProps {
  onNavigate: () => void;
}

/**
 * Suspending component that fetches and displays a single count.
 */
function AllItemsCount() {
  const [data] = trpc.entries.count.useSuspenseQuery({});
  return <>{data.unread}</>;
}

function StarredCount() {
  const [data] = trpc.entries.count.useSuspenseQuery({ starredOnly: true });
  return <>{data.unread}</>;
}

function SavedCount() {
  const [data] = trpc.entries.count.useSuspenseQuery({ type: "saved" });
  return <>{data.unread}</>;
}

/**
 * Minimal loading indicator for counts.
 */
function CountSkeleton() {
  return (
    <span className="inline-block h-4 w-4 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
  );
}

/**
 * Wraps a count component with ErrorBoundary and Suspense.
 * If the count fails to load, shows nothing (graceful degradation).
 */
function SuspenseCount({ children }: { children: React.ReactNode }) {
  return (
    <ErrorBoundary fallback={null}>
      <Suspense fallback={<CountSkeleton />}>{children}</Suspense>
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
    </div>
  );
}
