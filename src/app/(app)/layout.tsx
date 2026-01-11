/**
 * App Layout
 *
 * Server component wrapper that provides TRPCProvider and prefetches sidebar data.
 * The actual layout UI is in AppLayoutContent.
 */

import { dehydrate } from "@tanstack/react-query";
import { TRPCProvider, HydrationBoundary } from "@/lib/trpc/provider";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { AppLayoutContent } from "./AppLayoutContent";

interface AppLayoutProps {
  children: React.ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    // Prefetch sidebar data to avoid client-side fetches on every navigation
    await Promise.all([
      // Tags for sidebar tag list
      queryClient.prefetchQuery({
        queryKey: [["tags", "list"], { input: undefined, type: "query" }],
        queryFn: () => caller.tags.list(),
      }),
      // Subscriptions for sidebar feed list and unread counts
      queryClient.prefetchQuery({
        queryKey: [["subscriptions", "list"], { input: undefined, type: "query" }],
        queryFn: () => caller.subscriptions.list(),
      }),
      // Saved articles count for sidebar
      queryClient.prefetchQuery({
        queryKey: [["entries", "count"], { input: { type: "saved" }, type: "query" }],
        queryFn: () => caller.entries.count({ type: "saved" }),
      }),
      // Starred entries count for sidebar
      queryClient.prefetchQuery({
        queryKey: [["entries", "count"], { input: { starredOnly: true }, type: "query" }],
        queryFn: () => caller.entries.count({ starredOnly: true }),
      }),
    ]);
  }

  return (
    <TRPCProvider>
      <HydrationBoundary state={dehydrate(queryClient)}>
        <AppLayoutContent>{children}</AppLayoutContent>
      </HydrationBoundary>
    </TRPCProvider>
  );
}
