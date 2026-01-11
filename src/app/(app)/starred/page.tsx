/**
 * Starred Entries Page
 *
 * Server component that prefetches data for the starred entries view.
 * The actual UI is rendered by the client component.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { getViewPreferences } from "@/lib/hooks/viewPreferences";
import { StarredEntriesClient } from "./client";

interface StarredEntriesPageProps {
  searchParams: Promise<{ unreadOnly?: string; sort?: string }>;
}

export default async function StarredEntriesPage({ searchParams }: StarredEntriesPageProps) {
  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  // Parse URL params with localStorage defaults as fallback
  const params = await searchParams;
  const defaults = getViewPreferences("starred");
  const unreadOnly =
    params.unreadOnly === "false"
      ? false
      : params.unreadOnly === "true"
        ? true
        : defaults.showUnreadOnly;
  const sortOrder =
    params.sort === "oldest" ? "oldest" : params.sort === "newest" ? "newest" : defaults.sortOrder;

  if (session) {
    // Prefetch starred entries list (infinite query)
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        {
          input: { starredOnly: true, unreadOnly, sortOrder, limit: 20 },
          type: "infinite",
        },
      ],
      queryFn: () =>
        caller.entries.list({
          starredOnly: true,
          unreadOnly,
          sortOrder,
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
