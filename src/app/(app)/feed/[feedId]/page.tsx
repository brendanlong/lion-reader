/**
 * Single Feed Page
 *
 * Server component that prefetches data for the single feed view.
 * The actual UI is rendered by the client component.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { getViewPreferences } from "@/lib/hooks/viewPreferences";
import { SingleFeedClient } from "./client";

interface PageProps {
  params: Promise<{ feedId: string }>;
  searchParams: Promise<{ unreadOnly?: string; sort?: string }>;
}

export default async function SingleFeedPage({ params, searchParams }: PageProps) {
  const { feedId } = await params;
  const queryParams = await searchParams;
  const defaults = getViewPreferences("feed", feedId);
  const unreadOnly =
    queryParams.unreadOnly === "false"
      ? false
      : queryParams.unreadOnly === "true"
        ? true
        : defaults.showUnreadOnly;
  const sortOrder =
    queryParams.sort === "oldest"
      ? "oldest"
      : queryParams.sort === "newest"
        ? "newest"
        : defaults.sortOrder;

  const queryClient = createServerQueryClient();
  const { caller, session } = await createServerCaller();

  if (session) {
    // Prefetch entries list with feedId filter (infinite query)
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        { input: { feedId, unreadOnly, sortOrder, limit: 20 }, type: "infinite" },
      ],
      queryFn: () => caller.entries.list({ feedId, unreadOnly, sortOrder, limit: 20 }),
      initialPageParam: undefined,
    });

    // Prefetch subscriptions for feed info and unread counts
    await queryClient.prefetchQuery({
      queryKey: [["subscriptions", "list"], { input: undefined, type: "query" }],
      queryFn: () => caller.subscriptions.list(),
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SingleFeedClient />
    </HydrationBoundary>
  );
}
