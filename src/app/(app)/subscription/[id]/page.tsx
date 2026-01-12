/**
 * Single Subscription Page
 *
 * Server component that prefetches data for the single subscription view.
 * The actual UI is rendered by the client component.
 */

import { dehydrate } from "@tanstack/react-query";
import { createServerQueryClient, createServerCaller } from "@/lib/trpc/server";
import { HydrationBoundary } from "@/lib/trpc/provider";
import { getViewPreferences } from "@/lib/hooks/viewPreferences";
import { SingleSubscriptionClient } from "./client";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ unreadOnly?: string; sort?: string; entry?: string }>;
}

export default async function SingleSubscriptionPage({ params, searchParams }: PageProps) {
  const { id: subscriptionId } = await params;
  const queryParams = await searchParams;
  const defaults = getViewPreferences("subscription", subscriptionId);
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
    // Prefetch entries list with subscriptionId filter (infinite query)
    await queryClient.prefetchInfiniteQuery({
      queryKey: [
        ["entries", "list"],
        { input: { subscriptionId, unreadOnly, sortOrder, limit: 20 }, type: "infinite" },
      ],
      queryFn: () => caller.entries.list({ subscriptionId, unreadOnly, sortOrder, limit: 20 }),
      initialPageParam: undefined,
    });

    // Prefetch subscriptions for feed info and unread counts
    await queryClient.prefetchQuery({
      queryKey: [["subscriptions", "list"], { input: undefined, type: "query" }],
      queryFn: () => caller.subscriptions.list(),
    });

    // Prefetch entry content if viewing a specific entry
    // This eliminates the second round-trip when opening an entry
    if (queryParams.entry) {
      await queryClient.prefetchQuery({
        queryKey: [["entries", "get"], { input: { id: queryParams.entry }, type: "query" }],
        queryFn: () => caller.entries.get({ id: queryParams.entry! }),
      });
    }
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SingleSubscriptionClient />
    </HydrationBoundary>
  );
}
