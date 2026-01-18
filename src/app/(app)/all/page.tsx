/**
 * All Entries Page
 *
 * Displays all entries from all subscriptions.
 * Prefetches entries on the server for faster initial load.
 */

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createServerCaller, createServerQueryClient, isAuthenticated } from "@/lib/trpc/server";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";
import { AllEntriesContent } from "./AllEntriesContent";

interface AllEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function AllEntriesPage({ searchParams }: AllEntriesPageProps) {
  const queryClient = createServerQueryClient();

  if (await isAuthenticated()) {
    const trpc = await createServerCaller();
    const params = await searchParams;

    // Parse view preferences from URL (same logic as client hook)
    const urlParams = new URLSearchParams();
    if (params.unreadOnly) urlParams.set("unreadOnly", String(params.unreadOnly));
    if (params.sort) urlParams.set("sort", String(params.sort));
    const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams);

    // Prefetch entries with the same params as client
    const input = {
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
      <AllEntriesContent />
    </HydrationBoundary>
  );
}
