/**
 * App Layout
 *
 * Server component wrapper that provides TRPCProvider and prefetches common data.
 * The actual layout UI is in AppLayoutContent.
 *
 * Prefetches data used across all pages (sidebar, header):
 * - auth.me (user info for header)
 * - subscriptions.list (sidebar feed list)
 * - tags.list (sidebar tag list)
 * - entries.count (starred/saved counts)
 *
 * The initial sync cursor is generated after prefetching to ensure
 * no events are missed between prefetch and SSE connection.
 */

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { TRPCProvider } from "@/lib/trpc/provider";
import { createServerCaller, createServerQueryClient, isAuthenticated } from "@/lib/trpc/server";
import { AppLayoutContent } from "./AppLayoutContent";

interface AppLayoutProps {
  children: React.ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  const queryClient = createServerQueryClient();

  // Only prefetch if user is authenticated
  if (await isAuthenticated()) {
    const trpc = await createServerCaller();

    // Prefetch common data used in sidebar and header
    // These are independent queries so we can run them in parallel
    await Promise.all([
      // User info for header
      queryClient.prefetchQuery({
        queryKey: [["auth", "me"], { type: "query" }],
        queryFn: () => trpc.auth.me(),
      }),
      // Subscriptions for sidebar
      queryClient.prefetchQuery({
        queryKey: [["subscriptions", "list"], { type: "query" }],
        queryFn: () => trpc.subscriptions.list(),
      }),
      // Tags for sidebar
      queryClient.prefetchQuery({
        queryKey: [["tags", "list"], { type: "query" }],
        queryFn: () => trpc.tags.list(),
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
  }

  // Generate initial sync cursor AFTER prefetching completes
  // This ensures no events are missed between prefetch and SSE connection
  const initialSyncCursor = new Date().toISOString();

  return (
    <TRPCProvider>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <AppLayoutContent initialSyncCursor={initialSyncCursor}>{children}</AppLayoutContent>
      </HydrationBoundary>
    </TRPCProvider>
  );
}
