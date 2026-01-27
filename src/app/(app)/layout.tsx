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
 */

import { redirect } from "next/navigation";
import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { TRPCProvider } from "@/lib/trpc/provider";
import { createServerCaller, createServerQueryClient, isAuthenticated } from "@/lib/trpc/server";
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

  const queryClient = createServerQueryClient();

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

  // Prefetch common data used in sidebar and header
  // These are independent queries so we can run them in parallel
  const trpc = await createServerCaller();
  await Promise.all([
    // User info for header
    queryClient.prefetchQuery({
      queryKey: [["auth", "me"], { type: "query" }],
      queryFn: () => trpc.auth.me(),
    }),
    // Tags for sidebar (includes uncategorized counts)
    queryClient.prefetchQuery({
      queryKey: [["tags", "list"], { type: "query" }],
      queryFn: () => trpc.tags.list(),
    }),
    // All Articles count for sidebar
    queryClient.prefetchQuery({
      queryKey: [["entries", "count"], { input: {}, type: "query" }],
      queryFn: () => trpc.entries.count({}),
    }),
    // Saved count for sidebar
    queryClient.prefetchQuery({
      queryKey: [["entries", "count"], { input: { type: "saved" }, type: "query" }],
      queryFn: () => trpc.entries.count({ type: "saved" }),
    }),
    // Starred count for sidebar
    queryClient.prefetchQuery({
      queryKey: [["entries", "count"], { input: { starredOnly: true }, type: "query" }],
      queryFn: () => trpc.entries.count({ starredOnly: true }),
    }),
  ]);

  return (
    <TRPCProvider>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <AppLayoutContent initialCursors={initialCursors}>{children}</AppLayoutContent>
      </HydrationBoundary>
    </TRPCProvider>
  );
}
