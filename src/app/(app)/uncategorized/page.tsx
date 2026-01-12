/**
 * Uncategorized Entries Page
 *
 * Server component that prefetches data for the uncategorized entries view.
 * Reads view preferences from URL query params for accurate prefetching.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { UncategorizedEntriesClient } from "./client";
import { getViewPreferences } from "@/lib/hooks/viewPreferences";

interface PageProps {
  searchParams: Promise<{
    unreadOnly?: string;
    sort?: string;
    entry?: string;
  }>;
}

export default async function UncategorizedEntriesPage({ searchParams }: PageProps) {
  const params = await searchParams;

  // Get defaults from localStorage pattern (server will use defaults)
  const defaults = getViewPreferences("uncategorized");

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
    // Prefetch entries list with uncategorized filter
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        { input: { uncategorized: true, unreadOnly, sortOrder, limit: 20 }, type: "infinite" },
      ],
      queryFn: () => caller.entries.list({ uncategorized: true, unreadOnly, sortOrder, limit: 20 }),
      initialPageParam: undefined,
    });

    // Prefetch subscriptions for feed count and unread count
    await queryClient.prefetchQuery({
      queryKey: [["subscriptions", "list"], { input: undefined, type: "query" }],
      queryFn: () => caller.subscriptions.list(),
    });

    // Prefetch entry content if viewing a specific entry
    // This eliminates the second round-trip when opening an entry
    if (params.entry) {
      await queryClient.prefetchQuery({
        queryKey: [["entries", "get"], { input: { id: params.entry }, type: "query" }],
        queryFn: () => caller.entries.get({ id: params.entry! }),
      });
    }
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UncategorizedEntriesClient />
    </HydrationBoundary>
  );
}
