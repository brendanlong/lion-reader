/**
 * Starred Entries Page
 *
 * Server component that prefetches data for the starred entries view.
 * The actual UI is rendered by the client component.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { StarredEntriesClient } from "./client";

export default async function StarredEntriesPage() {
  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    // Prefetch starred entries list (infinite query)
    // Uses default view preferences: unreadOnly=true, sortOrder="newest"
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        {
          input: { starredOnly: true, unreadOnly: true, sortOrder: "newest", limit: 20 },
          type: "infinite",
        },
      ],
      queryFn: () =>
        caller.entries.list({
          starredOnly: true,
          unreadOnly: true,
          sortOrder: "newest",
          limit: 20,
        }),
      initialPageParam: undefined,
    });

    // Prefetch starred count for unread count display
    await queryClient.prefetchQuery({
      queryKey: [["entries", "count"], { input: { starredOnly: true }, type: "query" }],
      queryFn: () => caller.entries.count({ starredOnly: true }),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <StarredEntriesClient />
    </HydrationBoundary>
  );
}
