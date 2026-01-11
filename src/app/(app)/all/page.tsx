/**
 * All Entries Page
 *
 * Server component that prefetches data for the all entries view.
 * The actual UI is rendered by the client component.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { AllEntriesClient } from "./client";

export default async function AllEntriesPage() {
  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    // Prefetch entries list (infinite query)
    // Uses default view preferences: unreadOnly=true, sortOrder="newest"
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        { input: { unreadOnly: true, sortOrder: "newest", limit: 20 }, type: "infinite" },
      ],
      queryFn: () => caller.entries.list({ unreadOnly: true, sortOrder: "newest", limit: 20 }),
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
