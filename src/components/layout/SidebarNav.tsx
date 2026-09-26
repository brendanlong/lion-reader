/**
 * SidebarNav Component
 *
 * Navigation section of the sidebar with streaming unread counts.
 * Each count suspends independently, allowing the nav structure to render immediately.
 */

"use client";

import { Suspense } from "react";
import { useAppPathname } from "@/lib/hooks/useAppLocation";
import { trpc } from "@/lib/trpc/client";
import { NavLink } from "@/components/ui/nav-link";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

interface SidebarNavProps {
  /** Called with the link href when a nav link is clicked */
  onNavigate: (href: string) => void;
  /** Called on mousedown with the link href (e.g., to prefetch data) */
  onPrefetch?: (href: string) => void;
}

/**
 * Styled count badge for nav links. Returns null if count is 0.
 */
function CountBadge({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="ui-text-xs text-muted ml-2 shrink-0 tabular-nums">({count})</span>;
}

type CountInput = { starredOnly?: true; type?: "saved" };

/**
 * Suspending component that fetches and displays a single unread count.
 * Returns null when count is 0 (no badge shown).
 */
function UnreadCount({ input }: { input: CountInput }) {
  const [data] = trpc.entries.count.useSuspenseQuery(input);
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

const NAV_LINKS: Array<{ href: string; label: string; countInput?: CountInput }> = [
  { href: "/all", label: "All Items", countInput: {} },
  { href: "/starred", label: "Starred", countInput: { starredOnly: true } },
  { href: "/saved", label: "Saved", countInput: { type: "saved" } },
  { href: "/recently-read", label: "Recently Read" },
];

/**
 * Main navigation links with independently streaming unread counts.
 */
export function SidebarNav({ onNavigate, onPrefetch }: SidebarNavProps) {
  const pathname = useAppPathname();

  return (
    <div className="space-y-1 p-3">
      {NAV_LINKS.map(({ href, label, countInput }) => (
        <NavLink
          key={href}
          href={href}
          isActive={pathname === href}
          countElement={
            countInput && (
              <SuspenseCount>
                <UnreadCount input={countInput} />
              </SuspenseCount>
            )
          }
          onClick={onNavigate}
          onPrefetch={onPrefetch}
        >
          {label}
        </NavLink>
      ))}
    </div>
  );
}
