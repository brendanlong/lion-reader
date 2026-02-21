/**
 * App Layout
 *
 * Server component wrapper that provides TRPCProvider and prefetches common data.
 * The actual layout UI is in AppLayoutContent.
 *
 * Prefetches data used across all pages (sidebar, header, entry content):
 * - auth.me (user info for header)
 * - tags.list (sidebar tag structure and unread counts)
 * - entries.count (all/starred/saved counts for sidebar)
 * - entries.hasScoredEntries (sidebar "Best" link visibility)
 * - sync.cursors (lightweight max timestamps for SSE cursor initialization)
 * - summarization.isAvailable (for entry content summarization button)
 * - users["me.preferences"] (for entry vote controls visibility)
 *
 * Note: entries.list is prefetched per-page in EntryListPage based on route-specific filters
 *
 * Uses tRPC's hydration helpers to ensure query keys match exactly between
 * server prefetch and client query, preventing hydration mismatches.
 */

import { redirect } from "next/navigation";
import { TRPCProvider } from "@/lib/trpc/provider";
import { createHydrationHelpersForRequest, isAuthenticated } from "@/lib/trpc/server";
import { AppLayoutContent } from "./AppLayoutContent";

interface AppLayoutProps {
  children: React.ReactNode;
}

/**
 * App layout that wraps all authenticated pages.
 *
 * The layout renders AppLayoutContent which uses AppRouter to determine
 * what content to show based on the current pathname. This enables
 * client-side navigation via pushState without triggering SSR.
 *
 * Page files (page.tsx) still exist for prefetching route-specific data,
 * but their rendered output is not used - AppRouter handles all rendering.
 */
export default async function AppLayout({ children }: AppLayoutProps) {
  // Redirect unauthenticated users to login
  if (!(await isAuthenticated())) {
    redirect("/login");
  }

  // Use tRPC hydration helpers for prefetching - this ensures query keys match
  // exactly what the client will use, preventing cache misses
  const { trpc, HydrateClient } = await createHydrationHelpersForRequest();

  // Prefetch common data used in sidebar and header
  // These are independent queries so we can run them in parallel
  // No await needed - pending queries are dehydrated and streamed to the client
  // as they resolve (requires shouldDehydrateQuery config in query-client.ts)
  //
  // Note: sync.cursors is called directly (not prefetch) because we need its
  // return value to pass the initial cursors to the client. This prevents
  // the client from re-syncing with null cursors on SSE connect.
  // sync.cursors is a lightweight endpoint that just does MAX() queries,
  // avoiding the overhead of fetching all data just to get cursor timestamps.
  void Promise.all([
    trpc.auth.me.prefetch(),
    trpc.tags.list.prefetch(),
    trpc.entries.count.prefetch({}),
    trpc.entries.count.prefetch({ type: "saved" }),
    trpc.entries.count.prefetch({ starredOnly: true }),
    trpc.entries.hasScoredEntries.prefetch(), // For sidebar "Best" link visibility
    trpc.summarization.isAvailable.prefetch(), // For entry content summarization button
    trpc.users["me.preferences"].prefetch(), // For entry vote controls visibility
  ]);
  const initialCursors = await trpc.sync.cursors(); // Lightweight cursor-only query

  // children contains the page.tsx output (prefetch triggers), but AppRouter
  // handles all rendering based on pathname. We include children to ensure
  // Next.js runs the page.tsx files for prefetching.
  return (
    <TRPCProvider>
      <HydrateClient>
        <AppLayoutContent initialCursors={initialCursors} />
        {/* Page files run for prefetching but their output is hidden */}
        <div className="hidden">{children}</div>
      </HydrateClient>
    </TRPCProvider>
  );
}
