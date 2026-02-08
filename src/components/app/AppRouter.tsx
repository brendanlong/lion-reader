/**
 * AppRouter Component
 *
 * Top-level client-side router that reads usePathname() to determine
 * which page section to render. This enables client-side navigation
 * via pushState without triggering SSR.
 *
 * Server pages still handle prefetching - this just unifies client rendering.
 */

"use client";

import { Suspense } from "react";
import { usePathname } from "next/navigation";
import { UnifiedEntriesContent } from "@/components/entries/UnifiedEntriesContent";
import { UnifiedSettingsContent } from "@/components/settings/UnifiedSettingsContent";
import { SubscribeContent } from "@/components/subscribe/SubscribeContent";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";

/**
 * Loading skeleton for page transitions.
 */
function PageSkeleton() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-4 sm:p-6">
      <div className="mb-4 sm:mb-6">
        <div className="h-8 w-48 animate-pulse rounded bg-zinc-200 dark:bg-zinc-700" />
      </div>
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-24 animate-pulse rounded-lg bg-zinc-100 dark:bg-zinc-800" />
        ))}
      </div>
    </div>
  );
}

/**
 * Determines which page section to render based on pathname.
 */
function AppRouterContent() {
  const pathname = usePathname();

  // Settings pages
  if (pathname.startsWith("/settings")) {
    return <UnifiedSettingsContent />;
  }

  // Subscribe page
  if (pathname === "/subscribe") {
    return <SubscribeContent />;
  }

  // Entry list pages (default) - /all, /starred, /saved, /subscription/*, /tag/*, /uncategorized
  return <UnifiedEntriesContent />;
}

/**
 * Top-level router with error boundary and suspense.
 */
export function AppRouter() {
  return (
    <ErrorBoundary message="Something went wrong while loading this page.">
      <Suspense fallback={<PageSkeleton />}>
        <AppRouterContent />
      </Suspense>
    </ErrorBoundary>
  );
}
