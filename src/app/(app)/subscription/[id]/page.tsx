/**
 * Single Subscription Page
 *
 * Displays entries from a specific subscription.
 * Prefetches entries on the server for faster initial load.
 */

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createServerCaller, createServerQueryClient, isAuthenticated } from "@/lib/trpc/server";
import { parseViewPreferencesFromParams } from "@/lib/hooks/useUrlViewPreferences";
import { SingleSubscriptionContent } from "./SingleSubscriptionContent";

interface SingleSubscriptionPageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function SingleSubscriptionPage({
  params,
  searchParams,
}: SingleSubscriptionPageProps) {
  const queryClient = createServerQueryClient();

  if (await isAuthenticated()) {
    const trpc = await createServerCaller();
    const { id: subscriptionId } = await params;
    const searchParamsResolved = await searchParams;

    // Parse view preferences from URL (same logic as client hook)
    const urlParams = new URLSearchParams();
    if (searchParamsResolved.unreadOnly)
      urlParams.set("unreadOnly", String(searchParamsResolved.unreadOnly));
    if (searchParamsResolved.sort) urlParams.set("sort", String(searchParamsResolved.sort));
    const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams);

    // Prefetch entries for this subscription with the same params as client
    const input = {
      subscriptionId,
      unreadOnly,
      sortOrder,
      limit: 20,
    };

    await queryClient.prefetchInfiniteQuery({
      queryKey: [["entries", "list"], { input, type: "infinite" }],
      queryFn: () => trpc.entries.list(input),
      initialPageParam: undefined as string | undefined,
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SingleSubscriptionContent />
    </HydrationBoundary>
  );
}
