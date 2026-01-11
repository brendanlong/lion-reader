/**
 * All Entries Page
 *
 * Server component that prefetches data for the all entries view.
 * Reads view preferences from URL query params for accurate prefetching.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { AllEntriesClient } from "./client";
import { getViewPreferences } from "@/lib/hooks/viewPreferences";

interface PageProps {
  searchParams: Promise<{
    unreadOnly?: string;
    sort?: string;
  }>;
}

export default async function AllEntriesPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // Get defaults from localStorage pattern (server will use defaults)
  const defaults = getViewPreferences("all");

  // Parse URL params with fallback to defaults
  const unreadOnly =
    params.unreadOnly === "false"
      ? false
      : params.unreadOnly === "true"
        ? true
        : defaults.showUnreadOnly;
  const sortOrder =
    params.sort === "oldest" ? "oldest" : params.sort === "newest" ? "newest" : defaults.sortOrder;

  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    // Prefetch entries list with URL-specified filters
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        { input: { unreadOnly, sortOrder, limit: 20 }, type: "infinite" },
      ],
      queryFn: () => caller.entries.list({ unreadOnly, sortOrder, limit: 20 }),
      initialPageParam: undefined,
    });

    // Prefetch subscriptions for unread counts
    await queryClient.prefetchQuery({
      queryKey: [["subscriptions", "list"], { input: undefined, type: "query" }],
      queryFn: () => caller.subscriptions.list(),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AllEntriesClient />
    </HydrationBoundary>
  );
}
