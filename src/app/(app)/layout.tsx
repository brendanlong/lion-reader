/**
 * App Layout
 *
 * Server component wrapper that provides TRPCProvider and prefetches common data.
 * The actual layout UI is in AppLayoutContent.
 *
 * Prefetches data used across all pages (sidebar, header):
 * - auth.me (user info for header)
 * - tags.list (sidebar tag structure and unread counts)
 * - entries.count (all/starred/saved counts for sidebar)
 *
 * Initial sync uses null cursors to get all recent data, which then establishes
 * the baseline cursors for subsequent incremental syncs.
 *
 * Uses tRPC's hydration helpers to ensure query keys match exactly between
 * server prefetch and client query, preventing hydration mismatches.
 */

import { redirect } from "next/navigation";
import { TRPCProvider } from "@/lib/trpc/provider";
import { createHydrationHelpersForRequest, isAuthenticated } from "@/lib/trpc/server";
import { AppLayoutContent } from "./AppLayoutContent";
import { type SyncCursors } from "@/lib/hooks/useRealtimeUpdates";

interface AppLayoutProps {
  children: React.ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  // Redirect unauthenticated users to login
  if (!(await isAuthenticated())) {
    redirect("/login");
  }

  // Initial sync uses null cursors to fetch all recent data.
  // The sync endpoint will return proper cursors derived from the actual data,
  // which the client then uses for subsequent incremental syncs.
  const initialCursors: SyncCursors = {
    entries: null,
    entryStates: null,
    subscriptions: null,
    removedSubscriptions: null,
    tags: null,
  };

  // Use tRPC hydration helpers for prefetching - this ensures query keys match
  // exactly what the client will use, preventing cache misses
  const { trpc, HydrateClient } = await createHydrationHelpersForRequest();

  // Prefetch common data used in sidebar and header
  // These are independent queries so we can run them in parallel
  // Must await so the data is in the QueryClient before HydrateClient dehydrates
  await Promise.all([
    trpc.auth.me.prefetch(),
    trpc.tags.list.prefetch(),
    trpc.entries.count.prefetch({}),
    trpc.entries.count.prefetch({ type: "saved" }),
    trpc.entries.count.prefetch({ starredOnly: true }),
  ]);

  return (
    <TRPCProvider>
      <HydrateClient>
        <AppLayoutContent initialCursors={initialCursors}>{children}</AppLayoutContent>
      </HydrateClient>
    </TRPCProvider>
  );
}
