/**
 * Uncategorized Entries Page
 *
 * Displays entries from feeds with no tags.
 * Prefetches entries on the server for faster initial load.
 */

import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { createServerCaller, createServerQueryClient, isAuthenticated } from "@/lib/trpc/server";
import { parseViewPreferencesFromParams } from "@/lib/hooks/viewPreferences";
import { UncategorizedEntriesContent } from "./UncategorizedEntriesContent";

interface UncategorizedEntriesPageProps {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

export default async function UncategorizedEntriesPage({
  searchParams,
}: UncategorizedEntriesPageProps) {
  const queryClient = createServerQueryClient();

  if (await isAuthenticated()) {
    const trpc = await createServerCaller();
    const params = await searchParams;

    // Parse view preferences from URL (same logic as client hook)
    const urlParams = new URLSearchParams();
    if (params.unreadOnly) urlParams.set("unreadOnly", String(params.unreadOnly));
    if (params.sort) urlParams.set("sort", String(params.sort));
    const { unreadOnly, sortOrder } = parseViewPreferencesFromParams(urlParams);

    // Prefetch uncategorized entries with the same params as client
    // IMPORTANT: Include ALL fields (even undefined) to match the query key structure
    // that tRPC generates on the client side
    const input = {
      subscriptionId: undefined,
      tagId: undefined,
      uncategorized: true as const,
      unreadOnly,
      starredOnly: undefined,
      sortOrder,
      type: undefined,
      limit: 10,
    };

    await queryClient.prefetchInfiniteQuery({
      queryKey: [["entries", "list"], { input, type: "infinite" }],
      queryFn: () => trpc.entries.list(input),
      initialPageParam: undefined as string | undefined,
    });
  }

  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <UncategorizedEntriesContent />
    </HydrationBoundary>
  );
}
